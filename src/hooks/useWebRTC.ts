import { useState, useEffect, useRef } from "react";
import Peer, { DataConnection, MediaConnection } from "peerjs";

interface Participant {
  id: string;
  username: string;
  stream: MediaStream;
  isCreator: boolean;
  isScreenSharing?: boolean;
  streamType?: "camera" | "screen";
  transitionState?:
    | "connecting"
    | "connected"
    | "disconnecting"
    | "reconnecting";
}

interface UseWebRTCProps {
  roomId: string;
  isCreator: boolean;
  username: string;
  onDataReceived?: (data: unknown) => void;
}

interface DataMessage {
  type: string;
  peerId?: string;
  peers?: string[];
  isSharing?: boolean;
  sharingPeerId?: string;
  timestamp?: number;
  streamType?: "camera" | "screen";
  urgent?: boolean;
  forceRefresh?: boolean;
}

export const useWebRTC = ({
  roomId,
  isCreator,
  username,
  onDataReceived,
}: UseWebRTCProps) => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [networkTopology, setNetworkTopology] = useState<"mesh" | "star">(
    "mesh"
  );
  const [transitionsEnabled, setTransitionsEnabled] = useState(true);
  const [localUsername, setLocalUsername] = useState(username);

  // Recording states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedChunks, setRecordedChunks] = useState<BlobPart[]>([]);

  // Recording refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(
    null
  );

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<{
    [peerId: string]: {
      mediaConnection?: MediaConnection;
      dataConnection?: DataConnection;
    };
  }>({});

  // Track last time we saw each peer to handle reconnections
  const lastSeenRef = useRef<{ [peerId: string]: number }>({});

  // Get local media stream
  useEffect(() => {
    const getMedia = async () => {
      try {
        // Check if running on mobile
        const isMobile =
          /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
            navigator.userAgent
          );

        // Use different constraints based on device type
        const constraints = {
          audio: true,
          video: isMobile
            ? {
                facingMode: "user", // Front camera on mobile
                width: { ideal: 640, max: 1280 },
                height: { ideal: 480, max: 720 },
                frameRate: { ideal: 15, max: 24 },
              }
            : {
                width: { ideal: 1280, max: 1920 },
                height: { ideal: 720, max: 1080 },
                frameRate: { ideal: 24, max: 30 },
              },
        };

        console.log("Requesting media with constraints:", constraints);

        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          setLocalStream(stream);
        } catch (initialError) {
          // If first attempt fails, try with minimal constraints
          console.warn(
            "Initial getUserMedia failed, trying fallback constraints:",
            initialError
          );

          // Fallback to minimal video constraints
          const fallbackConstraints = {
            audio: true,
            video: {
              facingMode: "user",
              width: { ideal: 320 },
              height: { ideal: 240 },
            },
          };

          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia(
              fallbackConstraints
            );
            console.log("Using fallback stream with minimal constraints");
            setLocalStream(fallbackStream);
          } catch (fallbackError) {
            // If video fails completely, try audio only
            console.warn(
              "Video constraints failed, trying audio only:",
              fallbackError
            );

            try {
              const audioOnlyStream = await navigator.mediaDevices.getUserMedia(
                { audio: true, video: false }
              );
              console.log("Using audio-only stream");
              setLocalStream(audioOnlyStream);
              setError("Video access failed. Using audio only mode.");
            } catch (audioError) {
              throw audioError; // Re-throw if even audio fails
            }
          }
        }
      } catch (err) {
        console.error("Error accessing media devices:", err);

        // Provide more helpful error message based on error type
        if (err instanceof DOMException) {
          if (
            err.name === "NotAllowedError" ||
            err.name === "PermissionDeniedError"
          ) {
            setError(
              "Camera/microphone access denied. Please check your browser permissions."
            );
          } else if (
            err.name === "NotFoundError" ||
            err.name === "DevicesNotFoundError"
          ) {
            setError("No camera or microphone found. Please connect a device.");
          } else if (
            err.name === "NotReadableError" ||
            err.name === "TrackStartError"
          ) {
            setError(
              "Camera or microphone is already in use by another application."
            );
          } else if (err.name === "OverconstrainedError") {
            setError(
              "Your device doesn't support the requested video quality. Please try again."
            );
          } else {
            setError(`Could not access media: ${err.name}`);
          }
        } else {
          setError("Could not access media devices. Please check permissions.");
        }
      }
    };

    getMedia();

    return () => {
      // Clean up local stream on unmount
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Initialize PeerJS connection
  useEffect(() => {
    if (!localStream || !roomId) return;

    // Generate a unique peer ID based on roomId and role
    const peerId = isCreator ? `${roomId}-creator` : `${roomId}-${Date.now()}`;

    // Initialize PeerJS with STUN/TURN servers
    const peer = new Peer(peerId, {
      config: {
        iceServers: [
          // Google STUN servers
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          // Public TURN servers - use these guaranteed free servers with better reliability
          {
            urls: [
              "turn:turn.anyfirewall.com:443?transport=tcp",
              "turn:turn.anyfirewall.com:443",
            ],
            username: "webrtc",
            credential: "webrtc",
          },
          // Fallback TURN servers
          {
            urls: [
              "turn:openrelay.metered.ca:443?transport=tcp",
              "turn:openrelay.metered.ca:443",
            ],
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          // More high-quality free TURN servers for better reliability
          {
            urls: [
              "turn:freeturn.net:3478",
              "turn:freeturn.net:443",
              "turns:freeturn.tel:443",
              "turn:freeturn.tel:3478",
            ],
            username: "free",
            credential: "free",
          },
          // Globally distributed servers
          {
            urls: "turn:global.turn.twilio.com:3478?transport=udp",
            username:
              "f4b4035eaa76f4a55de5f4351567653ee4ff6fa97b50b6b334a41494b31be38b",
            credential: "myP3pp3r5n4p5",
          },
        ],
        iceCandidatePoolSize: 10,
        iceTransportPolicy: "all",
      },
      // Force reliable mode with longer timeouts
      pingInterval: 5000, // 5 seconds ping
      retryHandler: (errors) => {
        console.warn("PeerJS connection issues:", errors);
        return Math.min(errors * 1000, 15000); // Max retry timeout 15 seconds
      },
      debug: 2,
      metadata: {
        username: localUsername,
      },
    });

    // Add code to improve ICE connection diagnostics
    const enhanceIceLogging = () => {
      if (peer && typeof peer._pc === "object" && peer._pc) {
        try {
          // Access the underlying RTCPeerConnection
          const pc = peer._pc as RTCPeerConnection;

          // Log ICE connection state changes
          pc.addEventListener("iceconnectionstatechange", () => {
            console.log(`ICE Connection State: ${pc.iceConnectionState}`);

            // If failed, try to restart ICE
            if (pc.iceConnectionState === "failed") {
              console.warn("ICE Connection failed - attempting recovery");

              // Force all connections to use TURN servers
              Object.values(connectionsRef.current).forEach((conn) => {
                if (conn.mediaConnection) {
                  console.log("Attempting ICE restart for connection");

                  try {
                    // Only works if supported by browser
                    if (pc.restartIce) {
                      pc.restartIce();
                    }
                  } catch (err) {
                    console.error("ICE restart failed:", err);
                  }
                }
              });
            }
          });

          // Log ICE gathering state changes
          pc.addEventListener("icegatheringstatechange", () => {
            console.log(`ICE Gathering State: ${pc.iceGatheringState}`);
          });

          // Log when ICE candidates are generated
          pc.addEventListener("icecandidate", (event) => {
            if (event.candidate) {
              console.log(`ICE candidate: ${event.candidate.candidate}`);

              // Check if we're getting TURN server candidates
              const isRelay = event.candidate.candidate.indexOf("relay") !== -1;
              const isHost = event.candidate.candidate.indexOf("host") !== -1;
              const isSrflx = event.candidate.candidate.indexOf("srflx") !== -1;

              console.log(
                `Candidate type: ${
                  isRelay
                    ? "RELAY/TURN"
                    : isHost
                    ? "HOST"
                    : isSrflx
                    ? "SRFLX/STUN"
                    : "unknown"
                }`
              );
            }
          });
        } catch (err) {
          console.error("Could not enhance ICE logging:", err);
        }
      }
    };

    // Handle browser tab close/refresh
    const handleBeforeUnload = () => {
      // Notify peers about disconnection
      Object.entries(connectionsRef.current).forEach(
        ([peerId, connections]) => {
          if (connections.dataConnection?.open) {
            connections.dataConnection.send({
              type: "peer-disconnect",
              peerId: peer.id,
              timestamp: Date.now(),
            });
          }
        }
      );

      // Clean up connections
      Object.values(connectionsRef.current).forEach(
        ({ mediaConnection, dataConnection }) => {
          mediaConnection?.close();
          dataConnection?.close();
        }
      );

      // Close peer connection
      peer.destroy();
    };

    // Add beforeunload event listener
    window.addEventListener("beforeunload", handleBeforeUnload);

    peer.on("open", (id) => {
      console.log("My peer ID is:", id);
      peerRef.current = peer;
      setIsConnected(true);

      // Enable enhanced ICE logging
      enhanceIceLogging();

      // Update the username in metadata if it changes
      peer.metadata = { username: localUsername };

      // Immediately broadcast username to all peers every time we connect
      setTimeout(() => {
        console.log("Broadcasting initial username:", localUsername);
        sendDataToAll({
          type: "username",
          username: localUsername,
          peerId: peer.id,
          timestamp: Date.now(),
        });
      }, 1000);

      // Monitor WebRTC connection state
      peer.on("iceStateChanged", (state) => {
        console.log(`ICE connection state changed to: ${state}`);

        // If connection fails, try to use TURN servers
        if (state === "failed" || state === "disconnected") {
          console.warn(
            "ICE connection failed or disconnected. Attempting recovery..."
          );

          // Force use of TURN servers by changing iceTransportPolicy
          if (peer._pc) {
            try {
              const pc = peer._pc as RTCPeerConnection;
              // Try to restart ICE if possible
              if (pc.restartIce) {
                pc.restartIce();
              }
            } catch (err) {
              console.error("Error during ICE restart:", err);
            }
          }

          // Notify users of connection issues if we become disconnected
          if (isCreator) {
            sendDataToAll({
              type: "connection-status",
              status: "reconnecting",
              timestamp: Date.now(),
            });
          }
        }
      });

      // Set up data connection handling
      peer.on("connection", (dataConn) => {
        handleDataConnection(dataConn);
      });

      // If joiner, connect to the creator to join the room
      if (!isCreator) {
        connectToCreator(peer, roomId, localStream);
      } else {
        // If creator, announce presence to any late joiners by broadcasting periodically
        const broadcastInterval = setInterval(() => {
          // Notify all participants about each other
          broadcastPeerList();
        }, 10000); // Every 10 seconds

        return () => clearInterval(broadcastInterval);
      }
    });

    peer.on("error", (err) => {
      console.error("PeerJS error:", err);
      setError(`Connection error: ${err.type}`);
    });

    // Handle incoming calls
    peer.on("call", (call) => {
      console.log("Receiving call from:", call.peer);

      // Answer the call with our local stream
      call.answer(localStream);

      // Set initial transition state for this participant
      const existingParticipant = participants.find((p) => p.id === call.peer);
      const initialState = existingParticipant ? "reconnecting" : "connecting";
      setParticipantTransition(call.peer, initialState);

      // Try to get username from peer metadata if available
      let peerUsername = "Guest";
      if (call.metadata && call.metadata.username) {
        peerUsername = call.metadata.username;
      }

      // Handle incoming stream
      call.on("stream", (remoteStream) => {
        console.log("Received remote stream from:", call.peer);
        const isCreatorPeer = call.peer.includes("-creator");

        // Check if the peer is currently screen sharing
        const isScreenSharingPeer = participants.some(
          (p) => p.id === call.peer && p.isScreenSharing
        );

        // Determine stream type based on participant status or stream properties
        const streamType = isScreenSharingPeer ? "screen" : "camera";

        // Update last seen timestamp
        lastSeenRef.current[call.peer] = Date.now();

        setParticipants((prev) => {
          // If we already have this participant, update their stream
          const existingParticipant = prev.find((p) => p.id === call.peer);

          if (existingParticipant) {
            return prev.map((p) =>
              p.id === call.peer
                ? {
                    ...p,
                    stream: remoteStream,
                    streamType,
                    isScreenSharing: streamType === "screen",
                    username: p.username || peerUsername,
                  }
                : p
            );
          }

          // For new participants, if I'm not the creator and this isn't the creator,
          // I should also establish a direct connection to this new participant
          if (
            networkTopology === "mesh" &&
            !isCreator &&
            !isCreatorPeer &&
            peerRef.current
          ) {
            // Create a bidirectional connection with this new peer
            establishPeerConnection(call.peer);
          }

          return [
            ...prev,
            {
              id: call.peer,
              username: peerUsername,
              stream: remoteStream,
              isCreator: isCreatorPeer,
              isScreenSharing: streamType === "screen",
              streamType,
              transitionState: "connecting",
            },
          ];
        });
      });

      // Save the connection
      connectionsRef.current[call.peer] = {
        ...connectionsRef.current[call.peer],
        mediaConnection: call,
      };

      call.on("close", () => {
        handlePeerDisconnection(call.peer);
      });

      call.on("error", (err) => {
        console.error("Call error:", err);
      });
    });

    // Clean up connections when component unmounts
    return () => {
      // Remove beforeunload event listener
      window.removeEventListener("beforeunload", handleBeforeUnload);

      // Notify peers about disconnection
      Object.entries(connectionsRef.current).forEach(
        ([peerId, connections]) => {
          if (connections.dataConnection?.open) {
            connections.dataConnection.send({
              type: "peer-disconnect",
              peerId: peer.id,
              timestamp: Date.now(),
            });
          }
        }
      );

      // Close all connections
      Object.values(connectionsRef.current).forEach(
        ({ mediaConnection, dataConnection }) => {
          mediaConnection?.close();
          dataConnection?.close();
        }
      );

      // Close and destroy the peer
      peer.destroy();
      setIsConnected(false);
    };
  }, [localStream, roomId, isCreator, localUsername]);

  // Broadcast peer list to all connected participants
  const broadcastPeerList = () => {
    if (!isCreator || !peerRef.current) return;

    // Get all current peers including the creator
    const allPeers = [peerRef.current.id, ...participants.map((p) => p.id)];

    // Send to all participants
    Object.entries(connectionsRef.current).forEach(([peerId, connections]) => {
      if (connections.dataConnection?.open) {
        connections.dataConnection.send({
          type: "peer-list",
          peers: allPeers,
          timestamp: Date.now(),
        });
      }
    });
  };

  // Establish bidirectional connection with a peer
  const establishPeerConnection = (peerId: string) => {
    if (!peerRef.current || !localStream || peerId === peerRef.current.id)
      return;

    // If we already have a connection, don't create another one
    if (connectionsRef.current[peerId]?.mediaConnection) {
      return;
    }

    console.log("Establishing bidirectional connection with:", peerId);

    // Create data connection if it doesn't exist
    if (!connectionsRef.current[peerId]?.dataConnection) {
      const dataConn = peerRef.current.connect(peerId, {
        reliable: true,
        serialization: "json",
      });
      handleDataConnection(dataConn);
    }

    // Create media connection if it doesn't exist
    if (!connectionsRef.current[peerId]?.mediaConnection) {
      console.log("Creating new media connection with peer:", peerId);

      // Add connection options with ICE restart to help force TURN usage when needed
      const callOptions = {
        metadata: { username: localUsername },
        sdpTransform: (sdp: string) => {
          // This helps increase chances of connection through NAT
          return sdp.replace(
            /a=ice-options:trickle\r\n/g,
            "a=ice-options:trickle\r\na=ice-options:renomination\r\n"
          );
        },
        // Force TURN relay for more reliable connections across networks
        config: {
          iceTransportPolicy: "relay",
          iceCandidatePoolSize: 15,
        },
      };

      const call = peerRef.current.call(peerId, localStream, callOptions);

      // Save the connection
      connectionsRef.current[peerId] = {
        ...connectionsRef.current[peerId],
        mediaConnection: call,
      };

      // Add timeout to detect failed connections
      const connectionTimeout = setTimeout(() => {
        const existingConn = connectionsRef.current[peerId]?.mediaConnection;
        if (existingConn === call) {
          console.warn(
            `Connection to ${peerId} timed out. Attempting reconnect...`
          );

          // Retry connection with forced TURN relay
          const retryOptions = {
            ...callOptions,
            config: { iceTransportPolicy: "relay" },
          };

          try {
            // Close existing connection
            existingConn?.close();

            // Create new connection with forced relay
            const retryCall = peerRef.current?.call(
              peerId,
              localStream,
              retryOptions
            );
            if (retryCall) {
              console.log("Created retry connection with forced TURN relay");
              connectionsRef.current[peerId] = {
                ...connectionsRef.current[peerId],
                mediaConnection: retryCall,
              };

              // Set up stream handler again
              retryCall.on("stream", handleRemoteStream);

              retryCall.on("close", () => {
                handlePeerDisconnection(peerId);
              });

              retryCall.on("error", (err) => {
                console.error("Retry call error with peer:", peerId, err);
              });
            }
          } catch (err) {
            console.error("Error during connection retry:", err);
          }
        }
      }, 15000); // 15 seconds timeout

      // Define stream handler to avoid duplication
      const handleRemoteStream = (remoteStream: MediaStream) => {
        console.log("Received stream from peer:", peerId);
        clearTimeout(connectionTimeout); // Clear timeout on successful connection

        // Add the rest of your existing stream handling code here
        setParticipants((prev) => {
          // If we already have this participant, don't add it again
          if (prev.some((p) => p.id === peerId)) {
            return prev;
          }

          return [
            ...prev,
            {
              id: peerId,
              username: localUsername,
              stream: remoteStream,
              isCreator: peerId.includes("-creator"),
            },
          ];
        });
      };

      // Handle the stream
      call.on("stream", handleRemoteStream);

      call.on("close", () => {
        clearTimeout(connectionTimeout); // Clear timeout on clean close
        handlePeerDisconnection(peerId);
      });

      call.on("error", (err) => {
        console.error("Call error with peer:", peerId, err);
      });
    }
  };

  // Start screen sharing - revised to preserve participant connections
  const startScreenShare = async () => {
    if (!peerRef.current) return;

    try {
      // First store a copy of the current participants - IMPORTANT
      // We'll use this to ensure we don't lose participant visibility
      const existingParticipants = [...participants];

      console.log(
        "Starting screen share with current participants:",
        existingParticipants.map((p) => ({ id: p.id, isCreator: p.isCreator }))
      );

      // Get screen capture stream
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: true,
      });

      // Mark all tracks in the screen stream to identify them as screen content
      stream.getTracks().forEach((track) => {
        // Set content hint to 'screen' to help browsers optimize
        if (track.kind === "video" && "contentHint" in track) {
          track.contentHint = "screen";
        }
      });

      // Notify all participants BEFORE sending the stream or changing state
      if (peerRef.current) {
        // Send notification that we're starting screen sharing
        sendDataToAll({
          type: "screen-sharing-status",
          isSharing: true,
          peerId: peerRef.current.id,
          streamType: "screen",
          username: localUsername, // Send username with screen sharing notification
          timestamp: Date.now(),
        });

        // Also explicitly send screen-share-started with username to ensure consistency
        sendDataToAll({
          type: "screen-share-started",
          sharingPeerId: peerRef.current.id,
          streamType: "screen",
          username: localUsername, // Include username explicitly
          timestamp: Date.now(),
        });

        // Give a small delay for participants to prepare
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      // Update our own state
      setScreenStream(stream);
      setIsScreenSharing(true);

      // Listen for stream ending (user clicks "Stop sharing")
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        stopScreenShare();
      });

      // IMPORTANT: We'll create new connections only for screen sharing
      // without disturbing the existing connections for participant video/audio

      // Create a separate set of media connections just for screen sharing
      const screenConnections: { [peerId: string]: MediaConnection } = {};

      // Share screen with all participants
      for (const participant of existingParticipants) {
        const peerId = participant.id;
        if (peerId === peerRef.current.id) continue; // Skip self

        try {
          console.log("Sharing screen with participant:", peerId);

          // Create a new call specifically for screen sharing
          // This won't replace existing media connections!
          if (peerRef.current) {
            // Send the screen stream in a separate call
            const screenCall = peerRef.current.call(peerId, stream);
            screenConnections[peerId] = screenCall;

            // Notify the participant that this is a screen share
            const existingConn = connectionsRef.current[peerId];
            if (existingConn?.dataConnection?.open) {
              existingConn.dataConnection.send({
                type: "screen-sharing-stream",
                peerId: peerRef.current.id,
                streamType: "screen",
                timestamp: Date.now(),
              });
            }
          }
        } catch (err) {
          console.error("Error sharing screen with participant:", peerId, err);
        }

        // Small delay between calls to prevent overwhelming connections
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Store screen connections separately from regular connections
      // This is key to fixing the issue - we don't replace the existing connections
      if (peerRef.current) {
        // Store the screen connections for later cleanup
        (peerRef.current as any).screenConnections = screenConnections;
      }

      // Add transition states for all participants before screen sharing
      if (transitionsEnabled) {
        existingParticipants.forEach((participant) => {
          setParticipantTransition(participant.id, "reconnecting");
        });
      }
    } catch (err) {
      console.error("Error starting screen share:", err);
      setError("Failed to start screen sharing. Please try again.");
    }
  };

  // Stop screen sharing
  const stopScreenShare = () => {
    if (!peerRef.current || !screenStream) return;

    console.log("Stopping screen sharing and restoring camera feed");

    // Save a reference to the current peer to avoid null errors
    const currentPeer = peerRef.current;

    // First notify all participants that we're stopping screen sharing
    sendDataToAll({
      type: "screen-sharing-status",
      isSharing: false,
      peerId: currentPeer.id,
      timestamp: Date.now(),
    });

    // Stop all tracks in the screen stream
    screenStream.getTracks().forEach((track) => track.stop());
    setScreenStream(null);
    setIsScreenSharing(false);

    // Close the separate screen sharing connections, not the main connections
    if ((currentPeer as any).screenConnections) {
      const screenConnections = (currentPeer as any).screenConnections;
      Object.values(screenConnections).forEach((conn: any) => {
        if (conn && typeof conn.close === "function") conn.close();
      });

      // Clear the screen connections
      (currentPeer as any).screenConnections = {};
    }

    // IMPORTANT: Immediately re-establish camera connections with all participants
    // This is crucial to ensure the host can see participants after they stop sharing
    const establishAllCameraConnections = async () => {
      if (!localStream) return;

      console.log("Re-establishing camera connections with all participants");

      // Get a list of all current participants
      const participantIds = [...participants.map((p) => p.id)];

      // Add any connections that might not be in the participants list
      Object.keys(connectionsRef.current).forEach((peerId) => {
        if (!participantIds.includes(peerId) && peerId !== currentPeer.id) {
          participantIds.push(peerId);
        }
      });

      // Re-establish connections with each participant
      for (const peerId of participantIds) {
        if (peerId === currentPeer.id) continue; // Skip self

        try {
          console.log(`Re-establishing camera connection with: ${peerId}`);

          const conn = connectionsRef.current[peerId];

          // Check if we need to re-establish the connection
          if (!conn?.mediaConnection) {
            console.log(
              `Media connection missing for ${peerId}, creating new one`
            );
            // Force a new connection
            establishPeerConnection(peerId);
          } else {
            // Signal to the participant that they should re-establish with us
            if (conn.dataConnection?.open) {
              conn.dataConnection.send({
                type: "reconnect-after-screen-share",
                peerId: currentPeer.id,
                timestamp: Date.now(),
              });
            }
          }
        } catch (err) {
          console.error(`Error reconnecting with ${peerId}:`, err);
        }

        // Small delay between connections to avoid overwhelming
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      // Notify everyone that camera is restored and connections should be checked
      sendDataToAll({
        type: "camera-stream-restored",
        peerId: currentPeer.id,
        timestamp: Date.now(),
      });
    };

    // Start the reconnection process with a slight delay
    setTimeout(establishAllCameraConnections, 300);

    // Add transition states for smoother return to camera view
    if (transitionsEnabled) {
      participants.forEach((participant) => {
        if (participant.id !== currentPeer.id) {
          setParticipantTransition(participant.id, "reconnecting");
        }
      });
    }
  };

  // Helper function to reconnect all peers with camera
  const reconnectAllWithCamera = (stream: MediaStream) => {
    // First make a list of all current connections to avoid modification during iteration
    const currentConnections = { ...connectionsRef.current };

    // Check if peer reference is still valid
    if (!peerRef.current) {
      console.error("Cannot reconnect - peer reference is null");
      return;
    }

    // Store peer reference safely
    const peer = peerRef.current;

    // Call each peer with our camera stream in sequence (not all at once) to avoid overwhelming
    const reconnectInSequence = async () => {
      for (const [peerId, connections] of Object.entries(currentConnections)) {
        try {
          console.log("Reconnecting camera stream to peer:", peerId);

          // First, close any existing connection to ensure clean state
          if (connections.mediaConnection) {
            connections.mediaConnection.close();
            await new Promise((resolve) => setTimeout(resolve, 50)); // Short delay
          }

          // Call peer with camera stream
          const call = peer.call(peerId, stream);

          // Handle the stream - this is important to re-establish video properly
          call.on("stream", (remoteStream) => {
            console.log(
              "Re-established stream after screen sharing with:",
              peerId
            );

            // Update the participant in the list while preserving position
            setParticipants((prev) => {
              // Find if the participant exists
              const existingIndex = prev.findIndex((p) => p.id === peerId);

              if (existingIndex === -1) {
                // If not found, add them to the list
                return [
                  ...prev,
                  {
                    id: peerId,
                    username: localUsername,
                    stream: remoteStream,
                    isCreator: peerId.includes("-creator"),
                    isScreenSharing: false,
                  },
                ];
              }

              // Create a new array with all participants
              const newParticipants = [...prev];

              // Update only the participant that needs updating, preserving others
              newParticipants[existingIndex] = {
                ...newParticipants[existingIndex],
                stream: remoteStream,
                isScreenSharing: false,
                username: localUsername,
              };

              return newParticipants;
            });
          });

          // Handle errors
          call.on("error", (err) => {
            console.error("Error reconnecting after screen share:", err);

            // If there's an error, attempt to reconnect with this peer again
            setTimeout(() => {
              if (peer && stream.active) {
                console.log("Retrying camera connection with peer:", peerId);
                const retryCall = peer.call(peerId, stream);

                // Save the connection
                connectionsRef.current[peerId] = {
                  dataConnection: connections.dataConnection,
                  mediaConnection: retryCall,
                };
              }
            }, 1000);
          });

          // Save the connection - keep the data connection, just update media
          connectionsRef.current[peerId] = {
            dataConnection: connections.dataConnection,
            mediaConnection: call,
          };

          // Add small delay between calls to prevent overwhelming connections
          await new Promise((resolve) => setTimeout(resolve, 150));
        } catch (err) {
          console.error("Error reconnecting to peer:", peerId, err);
        }
      }
    };

    // Start the reconnection sequence
    reconnectInSequence();
  };

  // Handle data connection to exchange peer IDs
  const handleDataConnection = (dataConn: DataConnection) => {
    dataConn.on("open", () => {
      console.log("Data connection established with:", dataConn.peer);

      // Save the data connection
      connectionsRef.current[dataConn.peer] = {
        ...connectionsRef.current[dataConn.peer],
        dataConnection: dataConn,
      };

      // Send my username to the peer immediately
      dataConn.send({
        type: "username",
        username: localUsername,
        peerId: peerRef.current?.id,
        timestamp: Date.now(),
      });

      // Request the peer's username too
      dataConn.send({
        type: "request-username",
        peerId: peerRef.current?.id,
        timestamp: Date.now(),
      });

      // If we're the creator, send a list of all current participants to the new joiner
      if (isCreator) {
        const currentPeers = [
          peerRef.current?.id,
          ...participants.map((p) => p.id),
        ].filter(Boolean);

        dataConn.send({
          type: "peer-list",
          peers: currentPeers,
          timestamp: Date.now(),
        });

        // Announce new joiner to all existing participants
        Object.entries(connectionsRef.current).forEach(
          ([existingId, connections]) => {
            if (
              existingId !== dataConn.peer &&
              connections.dataConnection?.open
            ) {
              connections.dataConnection.send({
                type: "new-peer",
                peerId: dataConn.peer,
                timestamp: Date.now(),
              });
            }
          }
        );
      }

      // If someone is currently screen sharing, notify the new participant
      if (isScreenSharing && peerRef.current) {
        dataConn.send({
          type: "screen-sharing-status",
          isSharing: true,
          peerId: peerRef.current.id,
          streamType: "screen", // Identify this as screen content
          username: localUsername, // Include username for proper identification
        });

        // If we're the one sharing, we need to immediately call them with our screen
        if (screenStream) {
          setTimeout(() => {
            try {
              console.log(
                "Sending screen share to new participant:",
                dataConn.peer
              );

              // Ensure screen tracks are properly marked
              screenStream.getVideoTracks().forEach((track) => {
                track.contentHint = "screen";
              });

              const call = peerRef.current!.call(dataConn.peer, screenStream);

              // Update our connections ref
              connectionsRef.current[dataConn.peer] = {
                ...connectionsRef.current[dataConn.peer],
                mediaConnection: call,
              };

              // Also send metadata about this being a screen share
              dataConn.send({
                type: "stream-metadata",
                streamType: "screen",
                peerId: peerRef.current!.id,
                username: localUsername, // Include username
                timestamp: Date.now(),
              });

              // Send explicit screen-share-started message
              dataConn.send({
                type: "screen-share-started",
                sharingPeerId: peerRef.current.id,
                username: localUsername,
                timestamp: Date.now(),
              });
            } catch (err) {
              console.error("Error sharing screen with new participant:", err);
            }
          }, 500); // Small delay to ensure they've processed the status message
        }
      }
    });

    dataConn.on("data", (data: any) => {
      console.log("Received data:", data);

      // Handle screen sharing status updates
      if (data.type === "screen-sharing-status") {
        const sharingPeerId = data.peerId;
        const isSharing = data.isSharing;
        const streamType = data.streamType || "screen";
        const username = data.username; // Extract username from the message

        console.log(
          "Screen sharing status update:",
          sharingPeerId,
          isSharing,
          streamType,
          username
        );

        // Update the participant with the screen sharing status and username if provided
        setParticipants((prev) => {
          // If participant is turning off screen sharing
          if (!isSharing) {
            console.log("Participant stopped sharing screen:", sharingPeerId);
            return prev.map((p) =>
              p.id === sharingPeerId
                ? {
                    ...p,
                    isScreenSharing: false,
                    streamType: "camera",
                    username: username || p.username,
                  }
                : p
            );
          }

          // If turning on screen sharing
          console.log("Participant started sharing screen:", sharingPeerId);
          return prev.map((p) =>
            p.id === sharingPeerId
              ? {
                  ...p,
                  isScreenSharing: true,
                  streamType: "screen",
                  username: username || p.username, // Update username if provided
                }
              : p
          );
        });
      }

      // Handle explicit screen share stream metadata
      if (data.type === "screen-sharing-stream") {
        const sharingPeerId = data.peerId;
        const username = data.username; // Extract username
        console.log(
          "Received screen share stream metadata from:",
          sharingPeerId,
          username
        );

        // Update participant to explicitly mark their stream as screen share and update username
        setParticipants((prev) => {
          return prev.map((p) =>
            p.id === sharingPeerId
              ? {
                  ...p,
                  isScreenSharing: true,
                  streamType: "screen",
                  username: username || p.username, // Update username if provided
                }
              : p
          );
        });
      }

      // Handle stream metadata updates
      if (data.type === "stream-metadata" && data.streamType && data.peerId) {
        const streamType = data.streamType;
        const peerId = data.peerId;

        console.log(
          `Received stream metadata: ${peerId} is sharing ${streamType}`
        );

        // Update participant's stream type
        setParticipants((prev) =>
          prev.map((p) =>
            p.id === peerId
              ? {
                  ...p,
                  streamType: streamType,
                  isScreenSharing: streamType === "screen",
                }
              : p
          )
        );
      }

      // Handle peer list from creator
      if (data.type === "peer-list" && Array.isArray(data.peers)) {
        handlePeerList(data.peers);
      }

      // Handle notification about new peer
      if (
        data.type === "new-peer" &&
        data.peerId &&
        data.peerId !== peerRef.current?.id
      ) {
        // In mesh topology, connect to the new peer
        if (networkTopology === "mesh" || isCreator) {
          establishPeerConnection(data.peerId);
        }
      }

      // Handle request for peer list (only creator responds)
      if (data.type === "request-peer-list" && isCreator) {
        const currentPeers = [
          peerRef.current?.id,
          ...participants.map((p) => p.id),
        ].filter(Boolean);

        dataConn.send({
          type: "peer-list",
          peers: currentPeers,
          timestamp: Date.now(),
        });
      }

      // Handle peer disconnect notification
      if (data.type === "peer-disconnect" && data.peerId) {
        handlePeerDisconnection(data.peerId);
      }

      // Handle screen-share-retry-needed messages
      if (
        data.type === "screen-share-retry-needed" &&
        peerRef.current &&
        data.sharingPeerId
      ) {
        const sharingPeerId = data.sharingPeerId;
        console.log("Received screen share retry request from:", sharingPeerId);

        // Close any existing media connection to ensure clean slate
        const connection = connectionsRef.current[sharingPeerId];
        if (connection?.mediaConnection) {
          connection.mediaConnection.close();
          connectionsRef.current[sharingPeerId] = {
            ...connectionsRef.current[sharingPeerId],
            mediaConnection: undefined,
          };
        }

        // Request the screen stream again
        if (connection?.dataConnection?.open) {
          connection.dataConnection.send({
            type: "request-screen-stream",
            urgent: true,
            timestamp: Date.now(),
          });
        } else {
          // Try to establish connection
          establishPeerConnection(sharingPeerId);
        }
      }

      // Additional handler for direct screen share notification
      if (
        data.type === "screen-share-started" &&
        peerRef.current &&
        data.sharingPeerId
      ) {
        const sharingPeerId = data.sharingPeerId;
        const username = data.username; // Extract username

        console.log(
          "Received direct screen share notification from:",
          sharingPeerId,
          "with username:",
          username
        );

        // Force update the UI to show screen sharing status with correct username
        setParticipants((prev) => {
          // First check if we already have this participant
          const existingParticipant = prev.find((p) => p.id === sharingPeerId);

          if (existingParticipant) {
            // Update the participant with screen sharing flag and username
            return prev.map((p) =>
              p.id === sharingPeerId
                ? {
                    ...p,
                    isScreenSharing: true,
                    username: username || p.username, // Update username if provided
                  }
                : p
            );
          } else {
            // If we don't have the participant yet (rare case), prepare to add them
            console.log(
              "Screen sharing participant not in list, will request connection"
            );
            setTimeout(() => establishPeerConnection(sharingPeerId), 200);
            return prev;
          }
        });

        // Take a snapshot of participants to avoid race conditions
        const currentParticipants = [...participants];
        const existingParticipant = currentParticipants.find(
          (p) => p.id === sharingPeerId
        );

        // If participant exists but their stream might be wrong or missing, request it
        if (
          existingParticipant &&
          (!existingParticipant.stream ||
            !existingParticipant.stream.active ||
            existingParticipant.stream.getTracks().length === 0)
        ) {
          console.log(
            "Participant exists but stream may be invalid, requesting screen share"
          );

          // Request their screen stream explicitly
          setTimeout(() => {
            const connection = connectionsRef.current[sharingPeerId];
            if (connection?.dataConnection?.open) {
              connection.dataConnection.send({
                type: "request-screen-stream",
                urgent: true,
                timestamp: Date.now(),
              });
            }
          }, 300);

          return;
        }

        // Request the current stream if we don't have a valid connection
        setTimeout(() => {
          // Check if we already have a valid media connection
          const connection = connectionsRef.current[sharingPeerId];

          // Explicitly close any existing media connection to ensure we get the screen
          if (connection?.mediaConnection) {
            console.log(
              "Closing existing media connection to get fresh screen share"
            );
            connection.mediaConnection.close();

            connectionsRef.current[sharingPeerId] = {
              ...connectionsRef.current[sharingPeerId],
              mediaConnection: undefined,
            };
          }

          console.log("Requesting screen share stream from:", sharingPeerId);

          // Request the stream
          if (connection?.dataConnection?.open) {
            connection.dataConnection.send({
              type: "request-screen-stream",
              timestamp: Date.now(),
            });
          } else {
            // Try to establish a new connection
            establishPeerConnection(sharingPeerId);
          }
        }, 300);
      }

      // Handle direct request for screen stream
      if (
        data.type === "request-screen-stream" &&
        isScreenSharing &&
        screenStream &&
        peerRef.current
      ) {
        console.log("Received request for screen stream from:", dataConn.peer);
        // Send our screen stream
        try {
          // If we already have a media connection, close it to ensure clean connection
          const existingConnection = connectionsRef.current[dataConn.peer];
          if (existingConnection?.mediaConnection) {
            console.log(
              "Closing existing media connection before sending screen"
            );
            existingConnection.mediaConnection.close();
          }

          // Create a new call with our screen stream
          const call = peerRef.current.call(dataConn.peer, screenStream);

          // Log the screen stream info
          console.log(
            "Sending screen stream with tracks:",
            screenStream
              .getTracks()
              .map((t) => `${t.kind}:${t.readyState}`)
              .join(", ")
          );

          // Save the connection
          connectionsRef.current[dataConn.peer] = {
            ...connectionsRef.current[dataConn.peer],
            mediaConnection: call,
          };

          // Also send a confirmation via data channel
          if (existingConnection?.dataConnection?.open) {
            existingConnection.dataConnection.send({
              type: "screen-share-confirmed",
              timestamp: Date.now(),
            });
          }
        } catch (err) {
          console.error("Error sending screen stream on request:", err);
        }
      }

      // Handle request for full reconnection after issues
      if (
        data.type === "request-full-reconnect" &&
        localStream &&
        peerRef.current
      ) {
        console.log(
          "Received request for full reconnection from:",
          dataConn.peer
        );

        // Close any existing connection first
        const existingConnection = connectionsRef.current[dataConn.peer];
        if (existingConnection?.mediaConnection) {
          existingConnection.mediaConnection.close();
        }

        // Short delay to ensure clean closure
        setTimeout(() => {
          try {
            // Create fresh call with our camera
            const call = peerRef.current!.call(dataConn.peer, localStream);

            connectionsRef.current[dataConn.peer] = {
              dataConnection: existingConnection?.dataConnection,
              mediaConnection: call,
            };

            console.log(
              "Sent fresh camera stream after full reconnect request"
            );
          } catch (err) {
            console.error("Error during full reconnection:", err);
          }
        }, 100);
      }

      // Handle camera stream restored notification
      if (data.type === "camera-stream-restored" && peerRef.current) {
        const restoredPeerId = data.peerId;
        console.log(
          "Received camera stream restoration notification from:",
          restoredPeerId
        );

        // Update the participant to show they're no longer screen sharing
        setParticipants((prev) =>
          prev.map((p) =>
            p.id === restoredPeerId ? { ...p, isScreenSharing: false } : p
          )
        );

        // Always request a new stream after camera restoration to ensure we get the camera view
        const connection = connectionsRef.current[restoredPeerId];

        // Always request a new stream after camera restoration to ensure we get the camera view
        if (connection?.dataConnection?.open) {
          console.log(
            "Requesting fresh camera stream from peer who restored camera:",
            restoredPeerId
          );

          // Force close any existing media connection first
          if (connection.mediaConnection) {
            console.log(
              "Closing media connection to ensure clean camera stream"
            );
            connection.mediaConnection.close();
            connectionsRef.current[restoredPeerId] = {
              ...connection,
              mediaConnection: undefined,
            };
          }

          // Force participants list to show loading state for this participant
          setParticipants((prev) =>
            prev.map((p) => {
              if (p.id === restoredPeerId) {
                // Create an empty stream to force loading state
                const emptyStream = new MediaStream();
                return { ...p, stream: emptyStream, isScreenSharing: false };
              }
              return p;
            })
          );

          // Request a new stream with urgency flag
          connection.dataConnection.send({
            type: "request-stream-update",
            urgent: true,
            forceRefresh: true,
            timestamp: Date.now(),
          });

          // Set up a retry mechanism
          let retryCount = 0;
          const maxRetries = 3;

          const retryInterval = setInterval(() => {
            // Check if we have a valid stream for this participant
            const hasValidStream = participants.some(
              (p) =>
                p.id === restoredPeerId &&
                p.stream &&
                p.stream.active &&
                p.stream.getTracks().length > 0
            );

            if (!hasValidStream && retryCount < maxRetries) {
              console.log(
                `Retry ${
                  retryCount + 1
                }/${maxRetries} requesting camera from ${restoredPeerId}`
              );

              const currentConnection = connectionsRef.current[restoredPeerId];
              if (currentConnection?.dataConnection?.open) {
                currentConnection.dataConnection.send({
                  type: "request-stream-update",
                  urgent: true,
                  forceRefresh: true,
                  timestamp: Date.now(),
                });
              }

              retryCount++;
            } else {
              clearInterval(retryInterval);
            }
          }, 2000); // Try every 2 seconds
        } else {
          // Try to establish a new connection
          establishPeerConnection(restoredPeerId);
        }
      }

      // Handle request for stream update after screen sharing
      if (
        data.type === "request-stream-update" &&
        localStream &&
        peerRef.current
      ) {
        // The peer is requesting our stream after we stopped screen sharing
        // Call them with our local stream
        const peerToCall = dataConn.peer;
        const urgent = data.urgent === true;
        const forceRefresh = data.forceRefresh === true;

        console.log(
          "Received request for stream update from:",
          peerToCall,
          urgent ? "(urgent)" : "",
          forceRefresh ? "(force refresh)" : ""
        );

        try {
          // Close any existing media connection first to ensure clean slate
          const existingConnection = connectionsRef.current[peerToCall];
          if (existingConnection?.mediaConnection) {
            console.log(
              "Closing existing media connection before sending camera"
            );
            existingConnection.mediaConnection.close();
          }

          // Add a small delay to ensure clean connection
          setTimeout(
            () => {
              try {
                // Ensure our local stream is still valid
                if (
                  !localStream.active ||
                  localStream.getTracks().some((t) => t.readyState !== "live")
                ) {
                  console.log(
                    "Local stream appears inactive, attempting to get a fresh one before sending"
                  );

                  // Get a fresh stream if needed
                  navigator.mediaDevices
                    .getUserMedia({
                      video: true,
                      audio: true,
                    })
                    .then((freshStream) => {
                      // Update our local stream reference
                      setLocalStream(freshStream);
                      // Call with the fresh stream
                      createCallWithCamera(
                        peerToCall,
                        freshStream,
                        existingConnection
                      );
                    })
                    .catch((err) => {
                      console.error("Error getting fresh stream:", err);
                      // Try with existing stream anyway
                      createCallWithCamera(
                        peerToCall,
                        localStream,
                        existingConnection
                      );
                    });
                } else {
                  // Use existing stream which is still good
                  createCallWithCamera(
                    peerToCall,
                    localStream,
                    existingConnection
                  );
                }
              } catch (err) {
                console.error("Error sending camera stream:", err);
              }
            },
            urgent ? 50 : 100
          );
        } catch (err) {
          console.error("Error processing stream update request:", err);
        }
      }

      // Handle reconnect after screen share requests
      if (
        data.type === "reconnect-after-screen-share" &&
        localStream &&
        peerRef.current
      ) {
        const reconnectingPeerId = data.peerId;
        console.log(
          `Received reconnect request from peer after screen share: ${reconnectingPeerId}`
        );

        // Force a new connection with our camera
        if (reconnectingPeerId && reconnectingPeerId !== peerRef.current.id) {
          setTimeout(() => {
            console.log(
              `Re-establishing connection with: ${reconnectingPeerId}`
            );
            // Force close any existing connection
            const existingConn = connectionsRef.current[reconnectingPeerId];
            if (existingConn?.mediaConnection) {
              existingConn.mediaConnection.close();
              connectionsRef.current[reconnectingPeerId] = {
                ...existingConn,
                mediaConnection: undefined,
              };
            }

            // Create a new connection
            const call = peerRef.current!.call(
              reconnectingPeerId,
              localStream,
              {
                metadata: { username: localUsername },
              }
            );

            // Save the connection
            connectionsRef.current[reconnectingPeerId] = {
              ...connectionsRef.current[reconnectingPeerId],
              mediaConnection: call,
            };

            // Listen for the remote stream
            call.on("stream", (remoteStream) => {
              console.log(
                `Received stream from ${reconnectingPeerId} after reconnect`
              );

              // Update participant list
              setParticipants((prev) => {
                const existingIndex = prev.findIndex(
                  (p) => p.id === reconnectingPeerId
                );

                if (existingIndex >= 0) {
                  // Update existing participant
                  const updated = [...prev];
                  updated[existingIndex] = {
                    ...updated[existingIndex],
                    stream: remoteStream,
                    streamType: "camera",
                    isScreenSharing: false,
                    username: localUsername,
                  };
                  return updated;
                } else {
                  // Add as new participant
                  return [
                    ...prev,
                    {
                      id: reconnectingPeerId,
                      username: localUsername,
                      stream: remoteStream,
                      isCreator: reconnectingPeerId.includes("-creator"),
                      isScreenSharing: false,
                      streamType: "camera",
                    },
                  ];
                }
              });
            });
          }, 200);
        }
      }

      // Handle username updates
      if (data.type === "username" && data.username && data.peerId) {
        const username = data.username;
        const peerId = data.peerId;

        console.log(`Received username '${username}' from peer ${peerId}`);

        // Update participant's username
        setParticipants((prev) =>
          prev.map((p) => (p.id === peerId ? { ...p, username } : p))
        );

        // Also forward this username to other peers if I'm the creator
        // This helps ensure everyone has the latest usernames
        if (isCreator && peerRef.current && peerRef.current.id !== peerId) {
          Object.entries(connectionsRef.current).forEach(
            ([forwardPeerId, connections]) => {
              if (
                forwardPeerId !== peerId &&
                connections.dataConnection?.open
              ) {
                connections.dataConnection.send({
                  type: "username",
                  username: username,
                  peerId: peerId,
                  timestamp: Date.now(),
                });
              }
            }
          );
        }
      }

      // Add handler for recording status messages
      if (data.type === "recording-status") {
        const isRecordingActive = data.isRecording;
        const hostName = data.host;

        console.log(
          `Recording ${
            isRecordingActive ? "started" : "stopped"
          } by host: ${hostName}`
        );

        // You could update some UI state here to show recording status to participants
      }

      // Forward any data to the callback if provided
      if (
        onDataReceived &&
        data.type !== "peer-list" &&
        data.type !== "new-peer" &&
        data.type !== "request-peer-list" &&
        data.type !== "peer-disconnect" &&
        data.type !== "screen-sharing-status" &&
        data.type !== "request-stream-update" &&
        data.type !== "screen-share-started" &&
        data.type !== "request-screen-stream" &&
        data.type !== "camera-stream-restored" &&
        data.type !== "recording-status"
      ) {
        onDataReceived(data);
      }

      // Add handler for username request
      if (data.type === "request-username" && peerRef.current) {
        console.log(
          "Received username request, sending my username:",
          localUsername
        );
        dataConn.send({
          type: "username",
          username: localUsername,
          peerId: peerRef.current.id,
          timestamp: Date.now(),
        });
      }
    });

    dataConn.on("close", () => {
      console.log("Data connection closed with:", dataConn.peer);
    });

    dataConn.on("error", (err) => {
      console.error("Data connection error:", err);
    });
  };

  // Helper function for joiners to connect to the creator
  const connectToCreator = (
    peer: Peer,
    roomId: string,
    stream: MediaStream
  ) => {
    const creatorId = `${roomId}-creator`;
    console.log("Connecting to creator:", creatorId);

    // Set up creator connection retry logic
    let retryCount = 0;
    const maxRetries = 5; // Increase from 3 to 5 for more attempts
    let retryInterval: ReturnType<typeof setInterval> | null = null;

    const attemptCreatorConnection = () => {
      console.log(
        `Attempt ${retryCount + 1}/${maxRetries + 1} to connect to room creator`
      );

      // Establish data connection with creator first
      const dataConn = peer.connect(creatorId, {
        reliable: true,
        serialization: "json",
      });

      // Add additional debug logging for data connection
      console.log("Data connection object:", typeof dataConn);

      // Handle connection open event
      dataConn.on("open", () => {
        console.log("Data connection with creator established successfully");

        // Clear any retry timers since we connected successfully
        if (retryInterval) {
          clearInterval(retryInterval);
          retryInterval = null;
        }

        // Proceed with normal connection
        handleDataConnection(dataConn);

        // Call the creator with our media stream
        const callOptions = {
          metadata: { username: localUsername },
          sdpTransform: (sdp: string) => {
            // This enhances NAT traversal
            return sdp.replace(
              /a=ice-options:trickle\r\n/g,
              "a=ice-options:trickle\r\na=ice-options:renomination\r\n"
            );
          },
        };

        // Make the call to the creator with forced TURN relay
        const forceRelayConfig = {
          iceTransportPolicy: "relay",
          iceCandidatePoolSize: 15,
        };

        // Log that we're explicitly using relay
        console.log(
          "Connecting to creator with forced TURN relay",
          forceRelayConfig
        );

        // Make the call to the creator
        const call = peer.call(creatorId, stream, {
          ...callOptions,
          config: forceRelayConfig,
        });

        // Save both connections
        connectionsRef.current[creatorId] = {
          dataConnection: dataConn,
          mediaConnection: call,
        };

        // Handle the stream
        call.on("stream", (remoteStream) => {
          console.log("Received creator stream");

          setParticipants((prev) => {
            // If we already have this participant, don't add it again
            if (prev.some((p) => p.id === creatorId)) {
              return prev;
            }

            return [
              ...prev,
              {
                id: creatorId,
                username: localUsername,
                stream: remoteStream,
                isCreator: true,
              },
            ];
          });
        });

        call.on("close", () => {
          console.log("Media connection with creator closed");
          handlePeerDisconnection(creatorId);
        });

        call.on("error", (err) => {
          console.error("Call error with creator:", err);
          setError(
            "Media connection to host failed. Please refresh to try again."
          );
        });
      });

      // Handle connection error - crucial for retry logic
      dataConn.on("error", (err) => {
        console.error("Data connection error with creator:", err);

        // If we haven't exceeded max retries, try again
        if (retryCount < maxRetries) {
          retryCount++;
          console.log(
            `Creator connection failed. Retrying in 3 seconds (${retryCount}/${maxRetries})`
          );

          // Update error state with retry information
          setError(
            `Room host not found. Retrying connection (${retryCount}/${maxRetries})...`
          );
        } else {
          // If we've exhausted retries, show a more helpful error
          console.error(
            "Failed to connect to room creator after multiple attempts"
          );
          setError(
            "Could not connect to room host. Either the room doesn't exist or the host is offline."
          );

          // Clean up retry interval
          if (retryInterval) {
            clearInterval(retryInterval);
            retryInterval = null;
          }
        }
      });

      // Handle connection close
      dataConn.on("close", () => {
        console.log("Data connection with creator closed");
      });
    };

    // Make first connection attempt immediately
    attemptCreatorConnection();

    // Set up retry mechanism
    retryInterval = setInterval(() => {
      if (retryCount < maxRetries) {
        // Only retry if not connected
        if (!connectionsRef.current[creatorId]?.dataConnection?.open) {
          attemptCreatorConnection();
        } else {
          // If connected, clear the interval
          clearInterval(retryInterval);
          retryInterval = null;
        }
      } else {
        // Clear interval after max retries
        clearInterval(retryInterval);
        retryInterval = null;
      }
    }, 3000); // Try every 3 seconds
  };

  // Process the list of peers received from the creator
  const handlePeerList = (peerIds: string[]) => {
    if (!peerRef.current || !localStream) return;

    console.log("Received peer list:", peerIds);

    // Check if we're missing any connections
    const currentConnections = Object.keys(connectionsRef.current);
    const missingPeers = peerIds.filter(
      (id) =>
        !currentConnections.includes(id) &&
        id !== peerRef.current?.id &&
        !id.includes("-creator")
    );

    if (missingPeers.length > 0) {
      console.log("Detected missing connections to peers:", missingPeers);
    }

    // Connect to each peer in the list (except ourselves and the creator if we're not using mesh)
    peerIds.forEach((peerId) => {
      // Skip if it's our own ID
      if (peerId === peerRef.current?.id) {
        return;
      }

      // If we're not the creator in star topology, only connect to creator
      if (
        networkTopology === "star" &&
        !isCreator &&
        !peerId.includes("-creator")
      ) {
        return;
      }

      // If this is the creator and we're already connected to them, skip
      if (
        peerId.includes("-creator") &&
        connectionsRef.current[peerId]?.dataConnection?.open &&
        connectionsRef.current[peerId]?.mediaConnection
      ) {
        return;
      }

      // Establish bidirectional connection with this peer
      console.log(
        "Establishing/checking connection with peer from list:",
        peerId
      );
      establishPeerConnection(peerId);
    });

    // If in star topology and I'm not the creator, disconnect from non-creator peers
    if (networkTopology === "star" && !isCreator) {
      // Identify peers that are not the creator
      const nonCreatorPeers = Object.keys(connectionsRef.current).filter(
        (id) => !id.includes("-creator")
      );

      // Disconnect from them
      nonCreatorPeers.forEach((peerId) => {
        console.log(
          "Star topology: disconnecting from non-creator peer:",
          peerId
        );
        connectionsRef.current[peerId]?.mediaConnection?.close();
        connectionsRef.current[peerId]?.dataConnection?.close();
        delete connectionsRef.current[peerId];

        // Remove from participants list
        setParticipants((prev) => prev.filter((p) => p.id !== peerId));
      });
    }

    // Check if our participant list matches the peer list
    // This helps ensure our UI shows all connected peers
    setTimeout(() => {
      if (!peerRef.current) return;

      const currentParticipants = participants.map((p) => p.id);
      const peersToAdd = peerIds.filter(
        (id) => !currentParticipants.includes(id) && id !== peerRef.current?.id
      );

      if (peersToAdd.length > 0) {
        console.log("Peers missing from participant list:", peersToAdd);
        // These will be added automatically when the connections are established
      }
    }, 2000);
  };

  // Handle peer disconnection
  const handlePeerDisconnection = (peerId: string) => {
    console.log("Peer disconnected:", peerId);

    // First set the disconnecting state to trigger animation
    if (transitionsEnabled) {
      setParticipantTransition(peerId, "disconnecting");

      // Remove the participant after animation completes
      setTimeout(() => {
        setParticipants((prev) => prev.filter((p) => p.id !== peerId));
      }, 800); // Slightly shorter than the connection animation for a quick exit
    } else {
      // If transitions disabled, remove immediately
      setParticipants((prev) => prev.filter((p) => p.id !== peerId));
    }

    // Clean up connections
    if (connectionsRef.current[peerId]) {
      delete connectionsRef.current[peerId];
    }
  };

  // Toggle audio
  const toggleAudio = () => {
    if (localStream) {
      const audioTracks = localStream.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
    }
  };

  // Toggle video
  const toggleVideo = () => {
    if (localStream) {
      const videoTracks = localStream.getVideoTracks();
      videoTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
    }
  };

  // Switch between mesh and star network topologies
  const setTopology = (topology: "mesh" | "star") => {
    setNetworkTopology(topology);

    // If switching to star, disconnect non-creator peers from each other
    if (topology === "star" && !isCreator) {
      // Disconnect from all peers except the creator
      Object.entries(connectionsRef.current).forEach(
        ([peerId, connections]) => {
          if (!peerId.includes("-creator")) {
            connections.mediaConnection?.close();
            connections.dataConnection?.close();
            delete connectionsRef.current[peerId];

            // Remove from participants list
            setParticipants((prev) => prev.filter((p) => p.id === peerId));
          }
        }
      );
    }
    // If switching to mesh, reconnect to all peers
    else if (topology === "mesh" && !isCreator && peerRef.current) {
      const creatorId = `${roomId}-creator`;
      const dataConn = connectionsRef.current[creatorId]?.dataConnection;

      // Request updated peer list from creator
      if (dataConn?.open) {
        dataConn.send({
          type: "request-peer-list",
          timestamp: Date.now(),
        });
      }
    }
  };

  // Force reconnection to all peers
  const reconnectAll = () => {
    if (!peerRef.current || !localStream) return;

    if (isCreator) {
      // Creator broadcasts updated peer list
      broadcastPeerList();
    } else {
      // Non-creator reconnects to creator and requests peer list
      const creatorId = `${roomId}-creator`;

      // If creator connection is closed, reconnect
      if (!connectionsRef.current[creatorId]?.dataConnection?.open) {
        connectToCreator(peerRef.current, roomId, localStream);
      } else {
        // Request updated peer list
        connectionsRef.current[creatorId].dataConnection?.send({
          type: "request-peer-list",
          timestamp: Date.now(),
        });
      }
    }
  };

  // Send data to all connected peers
  const sendDataToAll = (data: unknown) => {
    if (!peerRef.current) return;

    Object.entries(connectionsRef.current).forEach(([peerId, connections]) => {
      if (connections.dataConnection?.open) {
        connections.dataConnection.send(data);
      }
    });
  };

  // Helper function to create a call with camera stream
  const createCallWithCamera = (
    peerId: string,
    stream: MediaStream,
    existingConnection:
      | {
          dataConnection?: DataConnection;
          mediaConnection?: MediaConnection;
        }
      | undefined
  ) => {
    if (!peerRef.current) return;

    // Call the peer with our camera stream
    const call = peerRef.current.call(peerId, stream);

    // Log what we're sending
    console.log(
      "Sending camera stream with tracks:",
      stream
        .getTracks()
        .map(
          (t) =>
            `${t.kind}:${t.readyState}:${t.enabled ? "enabled" : "disabled"}`
        )
        .join(", ")
    );

    // Save the connection
    connectionsRef.current[peerId] = {
      ...connectionsRef.current[peerId],
      mediaConnection: call,
    };

    // Confirm we sent the camera
    if (existingConnection?.dataConnection?.open) {
      existingConnection.dataConnection.send({
        type: "camera-stream-sent",
        timestamp: Date.now(),
      });
    }
  };

  // Add transition helper functions to manage participant state transitions
  const setParticipantTransition = (
    peerId: string,
    state: "connecting" | "connected" | "disconnecting" | "reconnecting"
  ) => {
    setParticipants((prev) => {
      return prev.map((p) =>
        p.id === peerId ? { ...p, transitionState: state } : p
      );
    });

    // If a participant is connecting or reconnecting, automatically transition to connected after a delay
    if (state === "connecting" || state === "reconnecting") {
      setTimeout(() => {
        setParticipants((prev) => {
          return prev.map((p) =>
            p.id === peerId &&
            (p.transitionState === "connecting" ||
              p.transitionState === "reconnecting")
              ? { ...p, transitionState: "connected" }
              : p
          );
        });
      }, 1000); // 1 second transition
    }
  };

  // Update the setUsername function to allow username changes
  const setUsername = (newUsername: string) => {
    setLocalUsername(newUsername);

    // Notify all participants about the username change
    sendDataToAll({
      type: "username",
      username: newUsername,
      peerId: peerRef.current?.id,
      timestamp: Date.now(),
    });
  };

  // Function to initialize recording canvas
  const initializeRecordingCanvas = () => {
    // Create canvas for recording
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
      canvasRef.current.width = 1280;
      canvasRef.current.height = 720;
    }

    // Create audio context for mixing audio streams
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
      audioDestinationRef.current =
        audioContextRef.current.createMediaStreamDestination();
    }
  };

  // Start recording function (only available to host)
  const startRecording = () => {
    if (!isCreator || isRecording || participants.length === 0) {
      console.error(
        "Cannot start recording: not a host, already recording, or no participants"
      );
      return;
    }

    try {
      initializeRecordingCanvas();

      // Get all streams for recording
      const streams = [
        ...participants.map((p) => p.stream),
        localStream,
      ].filter(Boolean) as MediaStream[];

      if (streams.length === 0) {
        setError("No streams available to record");
        return;
      }

      // Set up canvas for visual recording
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;

      // Create a combined audio stream
      const audioCtx = audioContextRef.current!;
      const audioDestination = audioDestinationRef.current!;

      // Connect all audio streams
      streams.forEach((stream) => {
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          const source = audioCtx.createMediaStreamSource(stream);
          source.connect(audioDestination);
        }
      });

      // Create a canvas stream with the mixed audio
      canvasStreamRef.current = canvas.captureStream(30);

      // Add the mixed audio to the canvas stream
      audioDestination.stream.getAudioTracks().forEach((track) => {
        canvasStreamRef.current!.addTrack(track);
      });

      // Create layout calculator based on number of streams
      const layoutStreams = (
        ctx: CanvasRenderingContext2D,
        streams: MediaStream[]
      ) => {
        const width = canvas.width;
        const height = canvas.height;

        // Clear canvas
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, width, height);

        if (streams.length === 0) return;

        // Determine grid layout based on number of streams
        let rows = 1;
        let cols = 1;

        if (streams.length <= 1) {
          rows = 1;
          cols = 1;
        } else if (streams.length <= 4) {
          rows = 2;
          cols = 2;
        } else if (streams.length <= 9) {
          rows = 3;
          cols = 3;
        } else {
          rows = 4;
          cols = Math.ceil(streams.length / 4);
        }

        const cellWidth = width / cols;
        const cellHeight = height / rows;

        // Draw each video stream
        streams.forEach((stream, index) => {
          if (index >= rows * cols) return;

          const videoTracks = stream.getVideoTracks();
          if (videoTracks.length === 0) return;

          const row = Math.floor(index / cols);
          const col = index % cols;

          const participant = [
            ...participants,
            {
              stream: localStream!,
              id: "local",
              username: localUsername,
              isCreator: true,
              isScreenSharing: false,
            },
          ].find((p) => p.stream === stream);

          // Get video element or create one
          let videoElem = document.getElementById(
            `recording-video-${index}`
          ) as HTMLVideoElement;
          if (!videoElem) {
            videoElem = document.createElement("video");
            videoElem.id = `recording-video-${index}`;
            videoElem.srcObject = stream;
            videoElem.autoplay = true;
            videoElem.muted = true;
            document.body.appendChild(videoElem);
            videoElem.style.display = "none";
          }

          // Draw video frame to canvas
          ctx.drawImage(
            videoElem,
            col * cellWidth,
            row * cellHeight,
            cellWidth,
            cellHeight
          );

          // Draw username
          if (participant) {
            ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
            ctx.fillRect(
              col * cellWidth,
              row * cellHeight + cellHeight - 30,
              cellWidth,
              30
            );

            ctx.fillStyle = "white";
            ctx.font = "16px Arial";
            ctx.textAlign = "left";
            ctx.fillText(
              participant.username + (participant.isCreator ? " (Host)" : ""),
              col * cellWidth + 10,
              row * cellHeight + cellHeight - 10
            );

            // Indicate if user is screen sharing
            if (participant.isScreenSharing) {
              ctx.fillStyle = "#0e71eb";
              ctx.fillRect(
                col * cellWidth + cellWidth - 110,
                row * cellHeight + cellHeight - 30,
                100,
                20
              );

              ctx.fillStyle = "white";
              ctx.font = "12px Arial";
              ctx.textAlign = "center";
              ctx.fillText(
                "Screen Sharing",
                col * cellWidth + cellWidth - 60,
                row * cellHeight + cellHeight - 15
              );
            }
          }
        });

        // Add recording indicator
        ctx.fillStyle = "#e02828";
        ctx.beginPath();
        ctx.arc(30, 30, 10, 0, 2 * Math.PI);
        ctx.fill();

        // Add timestamp
        const minutes = Math.floor(recordingTime / 60);
        const seconds = recordingTime % 60;
        ctx.fillStyle = "white";
        ctx.font = "16px Arial";
        ctx.textAlign = "left";
        ctx.fillText(
          `${minutes.toString().padStart(2, "0")}:${seconds
            .toString()
            .padStart(2, "0")}`,
          50,
          35
        );
      };

      // Set up animation frame for continuous drawing
      const drawFrames = () => {
        if (!isRecording) return;

        const allStreams = [
          ...participants.map((p) => p.stream),
          localStream,
        ].filter(Boolean) as MediaStream[];

        layoutStreams(ctx, allStreams);
        requestAnimationFrame(drawFrames);
      };

      // Start the animation loop
      drawFrames();

      // Create MediaRecorder with canvas stream
      const mediaRecorder = new MediaRecorder(canvasStreamRef.current!, {
        mimeType: "video/webm;codecs=vp9,opus",
        videoBitsPerSecond: 3000000, // 3 Mbps
      });

      mediaRecorderRef.current = mediaRecorder;

      // Handle data available event to collect recorded chunks
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          setRecordedChunks((prev) => [...prev, event.data]);
        }
      };

      // Start recording
      mediaRecorder.start(1000); // Collect data every second
      setIsRecording(true);
      setRecordedChunks([]);

      // Start timer
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((prevTime) => prevTime + 1);
      }, 1000);

      // Notify participants that recording has started
      sendDataToAll({
        type: "recording-status",
        isRecording: true,
        host: localUsername,
        timestamp: Date.now(),
      });

      console.log("Recording started");
    } catch (err) {
      console.error("Error starting recording:", err);
      setError("Failed to start recording. Please try again.");
    }
  };

  // Stop recording function
  const stopRecording = () => {
    if (!isRecording || !mediaRecorderRef.current) {
      return;
    }

    try {
      console.log(
        "Stopping recording with current recorded chunks:",
        recordedChunks.length
      );

      // Request the final data to be captured before stopping
      if (mediaRecorderRef.current.state !== "inactive") {
        // Force a final data capture
        mediaRecorderRef.current.requestData();

        // Small delay to ensure the final data is captured
        setTimeout(() => {
          if (mediaRecorderRef.current) {
            // Now stop the recorder
            mediaRecorderRef.current.stop();

            // Stop timer
            if (recordingTimerRef.current) {
              clearInterval(recordingTimerRef.current);
              recordingTimerRef.current = null;
            }

            // Clean up canvas stream
            if (canvasStreamRef.current) {
              canvasStreamRef.current
                .getTracks()
                .forEach((track) => track.stop());
              canvasStreamRef.current = null;
            }

            // Clean up audio context
            if (
              audioContextRef.current &&
              audioContextRef.current.state !== "closed"
            ) {
              audioContextRef.current.close();
              audioContextRef.current = null;
              audioDestinationRef.current = null;
            }

            // Remove video elements
            document
              .querySelectorAll('[id^="recording-video-"]')
              .forEach((elem) => {
                elem.remove();
              });

            // Notify participants that recording has stopped
            sendDataToAll({
              type: "recording-status",
              isRecording: false,
              host: localUsername,
              timestamp: Date.now(),
            });

            setIsRecording(false);
            console.log(
              "Recording stopped, chunks collected:",
              recordedChunks.length
            );

            // Save recording with a small delay to ensure all chunks are collected
            setTimeout(() => saveRecording(), 300);
          }
        }, 500); // Give half a second for the final data capture
      }
    } catch (err) {
      console.error("Error stopping recording:", err);
      setError("Failed to stop recording properly.");
    }
  };

  // Save recording function
  const saveRecording = () => {
    console.log(
      "Attempting to save recording with chunks:",
      recordedChunks.length
    );

    if (recordedChunks.length === 0) {
      console.error("No recording data available to save");
      setError("No recording data available to save");
      return;
    }

    try {
      // Create a blob from all chunks
      const blob = new Blob(recordedChunks, {
        type: "video/webm",
      });

      console.log("Created blob of size:", blob.size, "bytes");

      if (blob.size < 1000) {
        // Less than 1KB is probably an empty recording
        console.error("Recording blob is too small, likely empty");
        setError("Recording appears to be empty. Please try again.");
        return;
      }

      // Create a timestamp for filename
      const dateString = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `webrtc-recording-${roomId}-${dateString}.webm`;

      // Create download link
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      document.body.appendChild(a);
      a.style.display = "none";
      a.href = url;
      a.download = filename;

      // Trigger download
      a.click();

      // Clean up
      setTimeout(() => {
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        // Reset recorded chunks AFTER successful save
        setRecordedChunks([]);
      }, 100);

      console.log("Recording saved successfully as:", filename);
    } catch (err) {
      console.error("Error saving recording:", err);
      setError("Failed to save recording. Please try again.");
    }
  };

  // Clean up recording resources on component unmount
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }

      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }

      if (canvasStreamRef.current) {
        canvasStreamRef.current.getTracks().forEach((track) => track.stop());
      }

      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        audioContextRef.current.close();
      }

      document.querySelectorAll('[id^="recording-video-"]').forEach((elem) => {
        elem.remove();
      });
    };
  }, []);

  return {
    localStream,
    screenStream,
    isScreenSharing,
    participants,
    toggleAudio,
    toggleVideo,
    startScreenShare,
    stopScreenShare,
    error,
    isConnected,
    setTopology,
    networkTopology,
    reconnectAll,
    sendDataToAll,
    setTransitionsEnabled,
    username: localUsername,
    setUsername,
    // Recording features
    isRecording,
    recordingTime,
    startRecording,
    stopRecording,
    canStartRecording: isCreator && !isRecording,
    canStopRecording: isCreator && isRecording,
  };
};
