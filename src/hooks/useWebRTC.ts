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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        setLocalStream(stream);
      } catch (err) {
        setError("Could not access media devices. Please check permissions.");
        console.error("Error accessing media devices:", err);
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
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "stun:stun3.l.google.com:19302" },
          { urls: "stun:stun4.l.google.com:19302" },
          // Twilio STUN server
          { urls: "stun:global.stun.twilio.com:3478" },
          // OpenRelay STUN server
          { urls: "stun:stun.openrelay.metered.ca:80" },
          // OpenRelay TURN servers (UDP)
          {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
          // OpenRelay TURN servers (TCP)
          {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject",
          },
        ],
        iceCandidatePoolSize: 10,
      },
      debug: 2,
      metadata: {
        username: localUsername,
      },
    });

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

      // Update the username in metadata if it changes
      peer.metadata = { username: localUsername };

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
      const dataConn = peerRef.current.connect(peerId);
      handleDataConnection(dataConn);
    }

    // Create media connection if it doesn't exist
    if (!connectionsRef.current[peerId]?.mediaConnection) {
      const call = peerRef.current.call(peerId, localStream);

      // Save the connection
      connectionsRef.current[peerId] = {
        ...connectionsRef.current[peerId],
        mediaConnection: call,
      };

      // Handle the stream
      call.on("stream", (remoteStream) => {
        console.log("Received stream from peer:", peerId);

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
      });

      call.on("close", () => {
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

              const call = peerRef.current.call(dataConn.peer, screenStream);

              // Update our connections ref
              connectionsRef.current[dataConn.peer] = {
                ...connectionsRef.current[dataConn.peer],
                mediaConnection: call,
              };

              // Also send metadata about this being a screen share
              dataConn.send({
                type: "stream-metadata",
                streamType: "screen",
                peerId: peerRef.current.id,
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

        console.log(
          "Screen sharing status update:",
          sharingPeerId,
          isSharing,
          streamType
        );

        // Update the participant with the screen sharing status
        setParticipants((prev) => {
          // If participant is turning off screen sharing
          if (!isSharing) {
            console.log("Participant stopped sharing screen:", sharingPeerId);
            return prev.map((p) =>
              p.id === sharingPeerId
                ? { ...p, isScreenSharing: false, streamType: "camera" }
                : p
            );
          }

          // If turning on screen sharing
          console.log("Participant started sharing screen:", sharingPeerId);
          return prev.map((p) =>
            p.id === sharingPeerId
              ? { ...p, isScreenSharing: true, streamType: "screen" }
              : p
          );
        });
      }

      // Handle explicit screen share stream metadata
      if (data.type === "screen-sharing-stream") {
        const sharingPeerId = data.peerId;
        console.log(
          "Received screen share stream metadata from:",
          sharingPeerId
        );

        // Update participant to explicitly mark their stream as screen share
        setParticipants((prev) => {
          return prev.map((p) =>
            p.id === sharingPeerId
              ? { ...p, isScreenSharing: true, streamType: "screen" }
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

        console.log(
          "Received direct screen share notification from:",
          sharingPeerId
        );

        // Force update the UI to show screen sharing status
        setParticipants((prev) => {
          // First check if we already have this participant
          const existingParticipant = prev.find((p) => p.id === sharingPeerId);

          if (existingParticipant) {
            // Update the participant with screen sharing flag
            return prev.map((p) =>
              p.id === sharingPeerId ? { ...p, isScreenSharing: true } : p
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
        data.type !== "camera-stream-restored"
      ) {
        onDataReceived(data);
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

    // Establish data connection with creator first
    const dataConn = peer.connect(creatorId);
    handleDataConnection(dataConn);

    // Call the creator
    const call = peer.call(creatorId, stream);

    // Save the connection
    connectionsRef.current[creatorId] = {
      dataConnection: dataConn,
      mediaConnection: call,
    };

    // Handle the stream from the creator
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
      handlePeerDisconnection(creatorId);
    });

    call.on("error", (err) => {
      console.error("Call error:", err);
      setError("Failed to connect to room host. Please try again.");
    });
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
  };
};
