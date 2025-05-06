import React, { useEffect, useRef, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import {
  Video,
  Mic,
  MicOff,
  VideoOff,
  Phone,
  Copy,
  Users,
  MessageSquare,
  Send,
  ScreenShare,
  Pin,
  Clock,
} from "lucide-react";
import { useWebRTC } from "../hooks/useWebRTC";
import RecordingControls from "../components/RecordingControls";
import ParticipantsList from "../components/ParticipantsList";
import "../styles/recording.css";
import { useReactMediaRecorder } from "react-media-recorder";

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

interface ChatMessage {
  sender: string;
  text: string;
  timestamp: number;
  isFromMe: boolean;
}

// Define the message types we might receive
interface DataMessage {
  type: string;
  [key: string]: string | number | boolean | undefined | null;
}

interface ChatDataMessage extends DataMessage {
  type: "chat-message";
  sender: string;
  text: string;
  timestamp: number;
}

// For recording status notification to participants
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface RecordingStatusMessage extends DataMessage {
  type: "recording-status";
  isRecording: boolean;
  host: string;
  timestamp: number;
}

// Define component types at the top level
interface RemoteScreenShareProps {
  participant: Participant;
  onReconnectRequest?: () => void;
}

interface RemoteVideoProps {
  participant: Participant;
  isRecordingVisible: boolean;
  isPinned: boolean;
}

const Room: React.FC = () => {
  // URL params and routing
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const queryParams = new URLSearchParams(location.search);
  const isCreator = queryParams.get("isCreator") === "true";
  const usernameFromUrl =
    queryParams.get("username") ||
    (isCreator ? "Host" : `Guest-${Math.floor(Math.random() * 1000)}`);
  const roomTitle = queryParams.get("title") || "Untitled Meeting";

  // Local state
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isCopied, setIsCopied] = useState(false);
  const [isParticipantsOpen, setIsParticipantsOpen] = useState(false);
  const [pinnedParticipantId, setPinnedParticipantId] = useState<string | null>(
    null
  );

  // Add loading state for initial connection
  const [isConnecting, setIsConnecting] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Chat state - default open as requested
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [message, setMessage] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Recording state with useReactMediaRecorder
  const [recordingTime, setRecordingTime] = useState(0);
  const recordingTimerRef = useRef<number | null>(null);

  // Use react-media-recorder for screen recording
  const {
    status: recordingStatus,
    startRecording,
    stopRecording,
    clearBlobUrl,
  } = useReactMediaRecorder({
    screen: true,
    audio: true,
    video: true,
    mediaRecorderOptions: { mimeType: "video/webm" },
    onStop: (blobUrl, blob) => {
      // Auto-save the recording when stopped
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        document.body.appendChild(a);
        a.style.display = "none";
        a.href = url;
        const dateString = new Date().toISOString().replace(/[:.]/g, "-");
        a.download = `${roomTitle.replace(/\s+/g, "-")}-${dateString}.webm`;
        a.click();

        // Clean up
        setTimeout(() => {
          URL.revokeObjectURL(url);
          document.body.removeChild(a);
          clearBlobUrl();
        }, 100);
      }

      // Clear the recording timer
      if (recordingTimerRef.current) {
        window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
        setRecordingTime(0);
      }
    },
  });

  // The rest of WebRTC functionality
  const {
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
    sendDataToAll,
  } = useWebRTC({
    roomId: roomId || "",
    isCreator,
    username: usernameFromUrl,
    onDataReceived: handleDataReceived,
  });

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);

  // Check if any participant is sharing screen
  const screenSharingParticipant = participants.find((p) => p.isScreenSharing);
  const [screenShareConnected, setScreenShareConnected] = useState(true);

  // Map recording status to isRecording state
  const isRecording = recordingStatus === "recording";

  // Add a state to track if participants can see recording indicator
  const [isRecordingVisible, setIsRecordingVisible] = useState(false);

  // Update UI state based on WebRTC connection status
  useEffect(() => {
    // If we're connected to the WebRTC session, we're no longer connecting
    if (isConnected) {
      setIsConnecting(false);
      setConnectionError(null);
    }

    // If there's an error from WebRTC, update our error state
    if (error) {
      setConnectionError(error);
      setIsConnecting(false);
    }
  }, [isConnected, error]);

  // Redirect to home page after connection failure timeout
  useEffect(() => {
    let redirectTimer: number | null = null;

    if (connectionError && connectionError.includes("failed") && !isCreator) {
      // Redirect after 10 seconds for fatal errors
      redirectTimer = window.setTimeout(() => {
        navigate("/", {
          state: {
            error: connectionError,
            roomId,
          },
        });
      }, 10000);
    }

    return () => {
      if (redirectTimer) {
        clearTimeout(redirectTimer);
      }
    };
  }, [connectionError, navigate, roomId, isCreator]);

  // Helper to handle pinning a participant
  const handlePinParticipant = (id: string) => {
    // If already pinned, unpin it
    if (pinnedParticipantId === id) {
      setPinnedParticipantId(null);
    } else {
      setPinnedParticipantId(id);
    }
  };

  // Update the data received handler to handle unknown type
  function handleDataReceived(data: unknown) {
    // Type guard for data
    if (!data || typeof data !== "object") return;

    // Safe type casting
    const typedData = data as Record<string, unknown>;

    if (typedData.type === "chat-message") {
      const chatData = typedData as ChatDataMessage;
      const newMessage: ChatMessage = {
        sender: chatData.sender,
        text: chatData.text,
        timestamp: chatData.timestamp,
        isFromMe: false,
      };
      setChatMessages((prev) => [...prev, newMessage]);
    }

    // Handle recording status updates
    if (typedData.type === "recording-status") {
      setIsRecordingVisible(Boolean(typedData.isRecording));
    }
  }

  // Send chat message
  const sendChatMessage = () => {
    if (!message.trim()) return;

    // Create message object
    const chatMessage = {
      type: "chat-message",
      sender: usernameFromUrl,
      text: message,
      timestamp: Date.now(),
    };

    // Send to all peers
    sendDataToAll(chatMessage);

    // Add to local chat
    setChatMessages((prev) => [...prev, { ...chatMessage, isFromMe: true }]);

    // Clear input
    setMessage("");
  };

  // Auto-scroll chat to bottom when new messages arrive
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages]);

  // Existing useEffects and handlers
  useEffect(() => {
    if (localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (error) {
      // Check if this is a recording error or a critical connection error
      if (error.includes("recording") || error.includes("Recording")) {
        // Just show an alert for recording errors without redirecting
        alert(`Error: ${error}`);
      } else {
        // For critical connection errors, redirect to home page
        alert(`Error: ${error}. Redirecting to home page.`);
        navigate("/");
      }
    }
  }, [error, navigate]);

  const handleToggleMic = () => {
    toggleAudio();
    setIsMicOn(!isMicOn);
  };

  const handleToggleVideo = () => {
    toggleVideo();
    setIsVideoOn(!isVideoOn);
  };

  const handleCopyRoomId = () => {
    navigator.clipboard.writeText(
      window.location.origin + `/room/${roomId}?isCreator=false`
    );
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleLeaveRoom = () => {
    navigate("/");
  };

  // Handle Enter key in chat input
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  };

  // Handle screen sharing
  const [isTransitioning, setIsTransitioning] = useState(false);

  const handleToggleScreenShare = () => {
    if (isScreenSharing) {
      setIsTransitioning(true);
      stopScreenShare();
      // Add delay to make transition smoother
      setTimeout(() => {
        setIsTransitioning(false);
      }, 1000);
    } else {
      startScreenShare();
    }
  };

  // Update screen video element when screen stream changes
  useEffect(() => {
    if (screenStream && screenVideoRef.current) {
      console.log("Setting screen video source");
      screenVideoRef.current.srcObject = screenStream;
    }
  }, [screenStream]);

  // Handle smooth transitions when screen sharing changes
  useEffect(() => {
    // If screen sharing just stopped, set transitioning state
    if (!isScreenSharing && !screenSharingParticipant && !isTransitioning) {
      setIsTransitioning(true);
      setTimeout(() => {
        setIsTransitioning(false);
      }, 1000);
    }
  }, [isScreenSharing, screenSharingParticipant]);

  // Update local video when participants change
  useEffect(() => {
    if (localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, participants]);

  // Handle graceful video transitions with a cleanup function
  const cleanupVideoRefs = () => {
    // Clean up screen video ref to prevent black screens
    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = null;
    }

    // Ensure local video ref is properly set
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  };

  // Clean up videos when component unmounts
  useEffect(() => {
    return () => {
      cleanupVideoRefs();
    };
  }, []);

  // Clean up video refs when screen sharing status changes
  useEffect(() => {
    if (!isScreenSharing && !screenSharingParticipant) {
      // Small delay to ensure all state updates have completed
      const timeout = setTimeout(() => {
        cleanupVideoRefs();
      }, 300);

      return () => clearTimeout(timeout);
    }
  }, [isScreenSharing, screenSharingParticipant]);

  // Function to request a screen share reconnection
  const requestScreenShareReconnect = () => {
    if (!screenSharingParticipant) return;

    setScreenShareConnected(false);
    console.log(
      "Requesting screen share reconnection from:",
      screenSharingParticipant.id
    );

    // Send a reconnection request to all peers
    if (sendDataToAll) {
      sendDataToAll({
        type: "request-screen-stream",
        timestamp: Date.now(),
      });

      // Set a timeout to retry if we don't get a connection
      setTimeout(() => {
        if (!screenShareConnected) {
          console.log("Still no screen share connection, forcing UI update");
          setIsChatOpen(isChatOpen); // Force a re-render
        }
      }, 5000);

      // Reset the connected state after a moment to avoid flickering
      setTimeout(() => setScreenShareConnected(true), 2000);
    }
  };

  // Handle starting recording with timer
  const handleStartRecording = () => {
    startRecording();
    setRecordingTime(0);

    // Start timer for recording duration display
    recordingTimerRef.current = window.setInterval(() => {
      setRecordingTime((prev) => prev + 1);
    }, 1000);

    // Notify participants that recording has started
    sendDataToAll({
      type: "recording-status",
      isRecording: true,
      host: usernameFromUrl,
      timestamp: Date.now(),
    });
  };

  // Handle stopping recording
  const handleStopRecording = () => {
    stopRecording();

    // Notify participants that recording has stopped
    sendDataToAll({
      type: "recording-status",
      isRecording: false,
      host: usernameFromUrl,
      timestamp: Date.now(),
    });
  };

  // Clean up recording resources on component unmount
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) {
        window.clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      // Also clear blob URL if component unmounts during recording
      clearBlobUrl();
    };
  }, [clearBlobUrl]);

  // Add a recording banner at the top of the screen when recording
  const RecordingBanner = () => {
    if (!isRecording) return null;

    return (
      <div className="fixed top-0 left-0 right-0 bg-red-600 text-white py-1 text-center font-bold z-50 recording-banner">
        <div className="flex items-center justify-center gap-2">
          <div className="recording-dot"></div>
          <span>SCREEN RECORDING IN PROGRESS</span>
          <Clock size={16} />
          <span>
            {Math.floor(recordingTime / 60)
              .toString()
              .padStart(2, "0")}
            :{(recordingTime % 60).toString().padStart(2, "0")}
          </span>
          <div className="recording-dot"></div>
        </div>
        <div className="text-xs opacity-80">
          (Browser shows "sharing your screen" but you are recording)
        </div>
      </div>
    );
  };

  // Also add this effect to ensure local video stream is always properly attached
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      // Fix issue with local video not showing when pinned
      if (pinnedParticipantId === "local") {
        console.log("Ensuring local video is visible when pinned");
        const currentStream = localVideoRef.current.srcObject;

        // Only reset if needed
        if (currentStream !== localStream) {
          localVideoRef.current.srcObject = null;
          setTimeout(() => {
            if (localVideoRef.current) {
              localVideoRef.current.srcObject = localStream;
            }
          }, 50);
        }
      }
    }
  }, [localStream, pinnedParticipantId]);

  return (
    <div className="min-h-screen flex flex-col main-container">
      {/* Show connection loading state */}
      {isConnecting && (
        <div className="fixed inset-0 bg-gray-900 bg-opacity-90 z-50 flex items-center justify-center">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <h2 className="text-xl font-bold mb-2">Connecting to Room</h2>
            <p className="text-gray-300">
              {isCreator
                ? "Setting up your room..."
                : "Connecting to the host..."}
            </p>
          </div>
        </div>
      )}

      {/* Show connection error */}
      {connectionError && !isConnecting && (
        <div className="fixed inset-0 bg-gray-900 bg-opacity-90 z-50 flex items-center justify-center">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md text-center">
            <div className="text-red-500 text-5xl mb-4">⚠️</div>
            <h2 className="text-xl font-bold mb-2">Connection Error</h2>
            <p className="text-gray-300 mb-4">{connectionError}</p>
            {connectionError.includes("failed") && (
              <p className="text-gray-400 text-sm">
                Redirecting to home page in 10 seconds...
              </p>
            )}
            <button
              onClick={() => navigate("/")}
              className="mt-4 bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded"
            >
              Return to Home
            </button>
          </div>
        </div>
      )}

      {/* Show recording banner */}
      <RecordingBanner />

      {/* Room header */}
      <header className="bg-gray-800 p-4 shadow-md z-30">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center">
          <div className="flex items-center mb-3 sm:mb-0">
            <Video className="h-6 w-6 text-blue-500 mr-2" />
            <div>
              <h1 className="text-xl font-bold">WebRTC Room</h1>
              <h2 className="text-sm text-gray-400">{roomTitle}</h2>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => setIsParticipantsOpen(!isParticipantsOpen)}
              className={`flex items-center bg-gray-700 hover:bg-gray-600 rounded-lg px-3 py-2 transition-colors ${
                isParticipantsOpen ? "bg-blue-600 hover:bg-blue-700" : ""
              }`}
            >
              <Users className="h-4 w-4 text-blue-400 mr-2" />
              <span className="text-sm">
                {participants.length + 1} participants
              </span>
            </button>

            <div className="relative flex items-center bg-gray-700 rounded-lg px-3 py-2">
              <span className="text-sm mr-2 truncate max-w-[180px]">
                Room: {roomId}
              </span>
              <button
                onClick={handleCopyRoomId}
                className="text-blue-400 hover:text-blue-300 focus:outline-none"
                aria-label="Copy room link"
              >
                <Copy className="h-4 w-4" />
              </button>
              {isCopied && (
                <div className="absolute top-full left-0 mt-2 px-2 py-1 bg-gray-900 text-xs rounded">
                  Copied!
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main content with video grid and chat */}
      <main className="flex-1 p-4 sm:p-6 pb-20 overflow-hidden bg-gray-900 flex">
        {/* Video grid */}
        <div
          className={`h-full ${
            isChatOpen || isParticipantsOpen ? "w-3/4" : "w-full"
          } transition-all duration-300`}
        >
          {/* Loading overlay during transitions */}
          {isTransitioning && (
            <div className="absolute inset-0 bg-gray-900 bg-opacity-70 z-10 flex items-center justify-center transition-opacity duration-500">
              <div className="text-center">
                <div
                  className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-500 border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]"
                  role="status"
                >
                  <span className="!absolute !-m-px !h-px !w-px !overflow-hidden !whitespace-nowrap !border-0 !p-0 ![clip:rect(0,0,0,0)]">
                    Loading...
                  </span>
                </div>
                <p className="mt-2">Reconnecting video streams...</p>
              </div>
            </div>
          )}

          {/* Zoom-like layout with main view and side thumbnails */}
          <div className="h-full flex flex-col">
            {/* Main video display */}
            <div className="flex-1 bg-gray-800 rounded-lg overflow-hidden shadow-lg relative mb-2">
              {/* Determine main display based on pinned participant, screen sharing, or creator status */}
              {(() => {
                // If local user is screen sharing, prioritize showing that
                if (isScreenSharing) {
                  return (
                    <div className="h-full w-full relative">
                      <video
                        ref={screenVideoRef}
                        autoPlay
                        playsInline
                        className="w-full h-full object-contain bg-black"
                      />
                      <div className="absolute top-3 left-3 bg-gray-900 bg-opacity-70 rounded-md px-3 py-1 flex items-center gap-2">
                        <ScreenShare className="h-4 w-4 text-blue-400" />
                        <span className="text-sm font-medium">
                          You are sharing your screen
                        </span>
                      </div>
                    </div>
                  );
                }

                // If there's a pinned participant
                if (pinnedParticipantId) {
                  // If pinned is the local user
                  if (pinnedParticipantId === "local") {
                    return (
                      <div className="h-full w-full relative">
                        {/* Use key to force re-render when pinned/unpinned */}
                        <video
                          key={`pinned-local-${Date.now()}`}
                          ref={localVideoRef}
                          autoPlay
                          playsInline
                          muted
                          className={`w-full h-full object-cover ${
                            !isVideoOn ? "hidden" : ""
                          }`}
                        />

                        {!isVideoOn && (
                          <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                            <div className="h-24 w-24 rounded-full bg-gray-700 flex items-center justify-center">
                              <span className="text-4xl font-bold text-gray-500">
                                {usernameFromUrl.charAt(0).toUpperCase()}
                              </span>
                            </div>
                          </div>
                        )}

                        <div className="absolute bottom-4 left-4 bg-gray-900 bg-opacity-70 rounded-md px-3 py-1 flex items-center">
                          <span className="text-base font-medium">
                            {usernameFromUrl} (You)
                          </span>
                          <Pin className="h-3 w-3 ml-2 text-blue-400" />
                        </div>

                        {!isMicOn && (
                          <div className="absolute top-4 right-4 bg-red-500 rounded-full p-2">
                            <MicOff className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                    );
                  }

                  // If pinned is another participant
                  const pinnedParticipant = participants.find(
                    (p) => p.id === pinnedParticipantId
                  );
                  if (pinnedParticipant) {
                    return (
                      <div className="h-full w-full relative">
                        <RemoteVideo
                          participant={pinnedParticipant}
                          isRecordingVisible={isRecordingVisible}
                          isPinned={true}
                        />
                      </div>
                    );
                  }
                }

                // If someone else is screen sharing, show that
                if (screenSharingParticipant) {
                  return (
                    <RemoteScreenShare
                      participant={screenSharingParticipant}
                      onReconnectRequest={requestScreenShareReconnect}
                    />
                  );
                }

                // Default: if creator, show them, otherwise show creator
                if (isCreator) {
                  return (
                    <div className="h-full w-full relative">
                      <video
                        ref={localVideoRef}
                        autoPlay
                        playsInline
                        muted
                        className={`w-full h-full object-cover ${
                          !isVideoOn ? "hidden" : ""
                        }`}
                      />

                      {!isVideoOn && (
                        <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                          <div className="h-24 w-24 rounded-full bg-gray-700 flex items-center justify-center">
                            <span className="text-4xl font-bold text-gray-500">
                              {usernameFromUrl.charAt(0).toUpperCase()}
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="absolute bottom-4 left-4 bg-gray-900 bg-opacity-70 rounded-md px-3 py-1">
                        <span className="text-base font-medium">
                          {usernameFromUrl} (Host)
                        </span>
                      </div>

                      {!isMicOn && (
                        <div className="absolute top-4 right-4 bg-red-500 rounded-full p-2">
                          <MicOff className="h-4 w-4" />
                        </div>
                      )}
                    </div>
                  );
                } else {
                  const creator = participants.find((p) => p.isCreator);
                  if (creator) {
                    return (
                      <div className="h-full w-full relative">
                        <RemoteVideo
                          participant={creator}
                          isRecordingVisible={isRecordingVisible}
                          isPinned={false}
                        />
                      </div>
                    );
                  } else {
                    // Fallback to local user if creator not found
                    return (
                      <div className="h-full w-full relative">
                        <video
                          ref={localVideoRef}
                          autoPlay
                          playsInline
                          muted
                          className={`w-full h-full object-cover ${
                            !isVideoOn ? "hidden" : ""
                          }`}
                        />

                        {!isVideoOn && (
                          <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
                            <div className="h-24 w-24 rounded-full bg-gray-700 flex items-center justify-center">
                              <span className="text-4xl font-bold text-gray-500">
                                {usernameFromUrl.charAt(0).toUpperCase()}
                              </span>
                            </div>
                          </div>
                        )}

                        <div className="absolute bottom-4 left-4 bg-gray-900 bg-opacity-70 rounded-md px-3 py-1">
                          <span className="text-base font-medium">
                            {usernameFromUrl} (You)
                          </span>
                        </div>

                        {!isMicOn && (
                          <div className="absolute top-4 right-4 bg-red-500 rounded-full p-2">
                            <MicOff className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                    );
                  }
                }
              })()}
            </div>

            {/* Thumbnails row */}
            <div className="h-24 flex space-x-2 overflow-x-auto py-1">
              {/* Local user thumbnail */}
              <div
                className={`relative h-full aspect-video bg-gray-800 rounded-lg shadow-md cursor-pointer border-2 ${
                  pinnedParticipantId === "local"
                    ? "border-blue-500"
                    : "border-transparent"
                } hover:border-blue-400 transition-colors`}
                onClick={() => handlePinParticipant("local")}
              >
                {/* Create a separate video element for the thumbnail to prevent conflicts */}
                <div className="h-full w-full relative overflow-hidden rounded-lg">
                  <video
                    key="local-thumbnail"
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full object-cover rounded-lg ${
                      !isVideoOn ? "hidden" : ""
                    }`}
                    ref={(el) => {
                      // Set up the video source directly
                      if (el && localStream && !el.srcObject) {
                        el.srcObject = localStream;
                      }
                    }}
                  />
                </div>

                {!isVideoOn && (
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-800 rounded-lg">
                    <div className="h-10 w-10 rounded-full bg-gray-700 flex items-center justify-center">
                      <span className="text-xl font-bold text-gray-500">
                        {usernameFromUrl.charAt(0).toUpperCase()}
                      </span>
                    </div>
                  </div>
                )}

                <div className="absolute bottom-1 left-1 right-1 bg-gray-900 bg-opacity-70 rounded text-xs px-1 py-0.5 truncate">
                  {usernameFromUrl} (You)
                </div>

                {!isMicOn && (
                  <div className="absolute top-1 right-1 bg-red-500 rounded-full p-1">
                    <MicOff className="h-2 w-2" />
                  </div>
                )}

                {pinnedParticipantId === "local" && (
                  <div className="absolute top-1 left-1 bg-blue-500 rounded-full p-1">
                    <Pin className="h-2 w-2" />
                  </div>
                )}
              </div>

              {/* Other participants thumbnails */}
              {participants.map((participant) => (
                <div
                  key={participant.id}
                  className={`relative h-full aspect-video bg-gray-800 rounded-lg shadow-md cursor-pointer border-2 ${
                    pinnedParticipantId === participant.id
                      ? "border-blue-500"
                      : "border-transparent"
                  } hover:border-blue-400 transition-colors`}
                  onClick={() => handlePinParticipant(participant.id)}
                >
                  <RemoteVideo
                    participant={participant}
                    isRecordingVisible={false}
                    isPinned={pinnedParticipantId === participant.id}
                  />

                  {pinnedParticipantId === participant.id && (
                    <div className="absolute top-1 left-1 bg-blue-500 rounded-full p-1">
                      <Pin className="h-2 w-2" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Sidebar (Chat or Participants) */}
        <div
          className={`w-1/4 ${
            isChatOpen || isParticipantsOpen ? "block" : "hidden"
          } ml-4 flex flex-col z-20`}
        >
          {isParticipantsOpen && (
            <div className="flex-1 mb-4">
              <ParticipantsList
                participants={participants.map((p) => ({
                  id: p.id,
                  username: p.username,
                  isCreator: p.isCreator,
                  isScreenSharing: p.isScreenSharing || false,
                  isMuted: false,
                }))}
                currentUser={{
                  username: usernameFromUrl,
                  isCreator,
                }}
                onPinParticipant={handlePinParticipant}
                pinnedParticipantId={pinnedParticipantId}
              />
            </div>
          )}

          {isChatOpen && (
            <div
              className={`${
                isParticipantsOpen ? "flex-1" : "flex-1"
              } bg-gray-800 rounded-lg flex flex-col shadow-lg animate-fadeIn mb-16 chat-container`}
            >
              <div className="p-3 border-b border-gray-700 font-medium">
                <h3>Room Chat</h3>
              </div>

              {/* Messages container */}
              <div className="flex-1 overflow-y-auto p-3 space-y-3 chat-messages">
                {chatMessages.length === 0 ? (
                  <p className="text-gray-500 text-center text-sm py-4">
                    No messages yet
                  </p>
                ) : (
                  chatMessages.map((msg, index) => (
                    <div
                      key={index}
                      className={`max-w-[85%] ${
                        msg.isFromMe ? "ml-auto bg-blue-600" : "bg-gray-700"
                      } rounded-lg p-2 break-words`}
                    >
                      <div className="text-xs text-gray-300 mb-1">
                        {msg.isFromMe ? "You" : msg.sender}
                      </div>
                      <div>{msg.text}</div>
                      <div className="text-xs text-gray-300 mt-1 text-right">
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Message input with higher z-index */}
              <div className="p-3 border-t border-gray-700 flex bg-gray-800 relative z-30">
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message..."
                  className="flex-1 bg-gray-700 text-white rounded-l-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  onClick={sendChatMessage}
                  disabled={!message.trim()}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded-r-lg px-3 py-2"
                >
                  <Send className="h-5 w-5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Controls - Fixed position at bottom */}
      <div className="fixed bottom-0 left-0 right-0 bg-gray-900 bg-opacity-80 p-4 flex justify-center z-10 fixed-controls">
        <div className="flex space-x-4 items-center">
          {/* Mic Button */}
          <button
            onClick={handleToggleMic}
            className="rounded-full bg-gray-700 p-3 text-white hover:bg-gray-600 transition"
          >
            {isMicOn ? (
              <Mic size={20} />
            ) : (
              <MicOff size={20} className="text-red-500" />
            )}
          </button>

          {/* Video Button */}
          <button
            onClick={handleToggleVideo}
            className="rounded-full bg-gray-700 p-3 text-white hover:bg-gray-600 transition"
          >
            {isVideoOn ? (
              <Video size={20} />
            ) : (
              <VideoOff size={20} className="text-red-500" />
            )}
          </button>

          {/* Screen Share Button */}
          <button
            onClick={handleToggleScreenShare}
            className={`rounded-full p-3 text-white transition ${
              isScreenSharing
                ? "bg-blue-600 hover:bg-blue-700"
                : "bg-gray-700 hover:bg-gray-600"
            }`}
            disabled={!!screenSharingParticipant}
            title={
              screenSharingParticipant
                ? "Someone else is sharing their screen"
                : isScreenSharing
                ? "Stop sharing screen"
                : "Share screen"
            }
          >
            {isScreenSharing ? (
              <div className="w-5 h-5 flex items-center justify-center">■</div>
            ) : (
              <ScreenShare size={20} />
            )}
          </button>

          {/* Recording Controls */}
          <RecordingControls
            isCreator={isCreator}
            isRecording={isRecording || isRecordingVisible}
            recordingTime={recordingTime}
            startRecording={handleStartRecording}
            stopRecording={handleStopRecording}
            canStartRecording={isCreator && !isRecording}
            canStopRecording={isCreator && isRecording}
          />

          {/* Participants Button */}
          <button
            onClick={() => setIsParticipantsOpen(!isParticipantsOpen)}
            className={`rounded-full p-3 text-white transition ${
              isParticipantsOpen
                ? "bg-blue-600 hover:bg-blue-700"
                : "bg-gray-700 hover:bg-gray-600"
            }`}
          >
            <Users size={20} />
          </button>

          {/* Chat Button */}
          <button
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={`rounded-full p-3 text-white transition ${
              isChatOpen
                ? "bg-blue-600 hover:bg-blue-700"
                : "bg-gray-700 hover:bg-gray-600"
            }`}
          >
            <MessageSquare size={20} />
          </button>

          {/* Hangup/Leave Button */}
          <button
            onClick={handleLeaveRoom}
            className="rounded-full bg-red-600 p-3 text-white hover:bg-red-700 transition"
          >
            <Phone size={20} className="transform rotate-135" />
          </button>
        </div>
      </div>
    </div>
  );
};

// In the RemoteVideo component, add isRecordingVisible and isPinned as props
const RemoteVideo: React.FC<RemoteVideoProps> = ({
  participant,
  isRecordingVisible,
  isPinned,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [streamActive, setStreamActive] = useState(true);
  const [lastStreamUpdateTime, setLastStreamUpdateTime] = useState(Date.now());
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [trackCount, setTrackCount] = useState(0);

  useEffect(() => {
    if (videoRef.current && participant.stream) {
      console.log(
        `Setting video for participant ${participant.id}${
          participant.isScreenSharing ? " (sharing screen)" : ""
        } with ${participant.stream.getTracks().length} tracks`
      );

      // Show loading state
      setIsVideoLoading(true);
      setTrackCount(participant.stream.getTracks().length);

      // Check if stream is different from previous
      if (videoRef.current.srcObject !== participant.stream) {
        console.log("Stream object changed, updating video source");
        videoRef.current.srcObject = participant.stream;
        setLastStreamUpdateTime(Date.now());
      }

      // Handle video loaded event
      const handleVideoLoaded = () => {
        setIsVideoLoading(false);
      };

      // Handle error event
      const handleVideoError = (e: Event) => {
        console.error(`Video error for participant ${participant.id}:`, e);
        setStreamActive(false);
      };

      videoRef.current.addEventListener("loadeddata", handleVideoLoaded);
      videoRef.current.addEventListener("error", handleVideoError);

      // Check if stream is active
      const checkStreamActivity = () => {
        if (videoRef.current && videoRef.current.srcObject) {
          const mediaStream = videoRef.current.srcObject as MediaStream;
          const active =
            mediaStream.active &&
            mediaStream
              .getTracks()
              .some((track) => track.readyState === "live");

          if (!active && streamActive) {
            console.log(
              `Stream for participant ${participant.id} appears inactive`
            );

            // Try to fix stream if it became inactive
            if (Date.now() - lastStreamUpdateTime > 2000) {
              console.log(`Attempting to reset video for ${participant.id}`);
              const currentStream = videoRef.current.srcObject;
              videoRef.current.srcObject = null;

              // Small delay before re-attaching stream
              setTimeout(() => {
                if (videoRef.current) {
                  videoRef.current.srcObject = currentStream;
                  setLastStreamUpdateTime(Date.now());
                }
              }, 100);
            }
          }

          setStreamActive(active);
          setTrackCount(mediaStream.getTracks().length);
        }
      };

      // Check immediately and periodically
      checkStreamActivity();
      const intervalId = setInterval(checkStreamActivity, 2000);

      return () => {
        clearInterval(intervalId);
        if (videoRef.current) {
          videoRef.current.removeEventListener("loadeddata", handleVideoLoaded);
          videoRef.current.removeEventListener("error", handleVideoError);
          videoRef.current.srcObject = null;
        }
      };
    }
  }, [
    participant.stream,
    participant.id,
    participant.isScreenSharing,
    streamActive,
    lastStreamUpdateTime,
  ]);

  // If stream changes or participant stops sharing screen, force a video element update
  useEffect(() => {
    if (videoRef.current && participant.stream) {
      console.log(
        `Ensuring video element is updated for ${participant.id}${
          participant.isScreenSharing ? " with screen share" : ""
        }`
      );

      // Reset the video loading state
      setIsVideoLoading(true);

      // Quick reset to ensure video element picks up the stream correctly
      const currentStream = participant.stream;
      videoRef.current.srcObject = null;

      // Small delay to ensure clean update
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = currentStream;
          setLastStreamUpdateTime(Date.now());
        }
      }, 50);
    }
  }, [participant.stream, participant.isScreenSharing, participant.id]);

  return (
    <div className="relative w-full h-full">
      {/* Add recording indicator for participants when host is recording */}
      {!participant.isCreator && isRecordingVisible && (
        <div className="recording-indicator">
          <div className="indicator-dot"></div>
          <span className="indicator-text">Recording</span>
        </div>
      )}

      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`w-full h-full object-cover transition-opacity duration-300 ${
          isVideoLoading ? "opacity-0" : "opacity-100"
        }`}
      />

      {(isVideoLoading || !streamActive || trackCount === 0) && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
          {isVideoLoading ? (
            <div className="text-center">
              <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-500 border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]"></div>
              <p className="mt-2 text-sm text-gray-400">Connecting video...</p>
            </div>
          ) : (
            <div className="h-16 w-16 rounded-full bg-gray-700 flex items-center justify-center">
              <span className="text-2xl font-bold text-gray-500">
                {participant.username.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
        </div>
      )}

      {isPinned && (
        <div
          className="absolute top-3 left-3 bg-blue-500 rounded-full p-1.5"
          title="This participant is pinned"
        >
          <Pin className="h-4 w-4" />
        </div>
      )}

      <div className="absolute bottom-3 left-3 bg-gray-900 bg-opacity-70 rounded-md px-2 py-1">
        <span className="text-sm font-medium">
          {participant.username} {participant.isCreator ? "(Host)" : ""}
        </span>
      </div>

      {participant.isScreenSharing && (
        <div
          className="absolute top-3 right-3 bg-blue-500 rounded-full p-1.5"
          title="This participant is sharing their screen"
        >
          <ScreenShare className="h-4 w-4" />
        </div>
      )}
    </div>
  );
};

// Component for remote screen sharing
const RemoteScreenShare: React.FC<RemoteScreenShareProps> = ({
  participant,
  onReconnectRequest,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isStreamActive, setIsStreamActive] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [lastReconnectTime, setLastReconnectTime] = useState(0);

  useEffect(() => {
    console.log(
      "RemoteScreenShare: Setting up with participant:",
      participant.id,
      participant.isScreenSharing
    );

    // Set up the video element with the stream
    if (videoRef.current && participant.stream) {
      setIsLoading(true);
      console.log(
        "RemoteScreenShare: Attaching stream with tracks:",
        participant.stream.getTracks().length
      );

      videoRef.current.srcObject = participant.stream;

      // Handle video loaded event
      const handleVideoLoaded = () => {
        setIsLoading(false);
        setIsStreamActive(true);
      };

      // Handle error event
      const handleVideoError = () => {
        console.error("Screen share video error");
        setIsStreamActive(false);

        // Auto-reconnect on error if we haven't tried too recently
        if (
          Date.now() - lastReconnectTime > 3000 &&
          reconnectAttempts < 3 &&
          onReconnectRequest
        ) {
          console.log("Auto-reconnecting screen share due to video error");
          setLastReconnectTime(Date.now());
          setReconnectAttempts((prev) => prev + 1);
          onReconnectRequest();
        }
      };

      videoRef.current.addEventListener("loadeddata", handleVideoLoaded);
      videoRef.current.addEventListener("error", handleVideoError);

      // Listen for stream activity changes
      const checkStreamActivity = () => {
        if (videoRef.current && videoRef.current.srcObject) {
          const mediaStream = videoRef.current.srcObject as MediaStream;
          const active =
            mediaStream.active &&
            mediaStream
              .getTracks()
              .some((track) => track.readyState === "live" && track.enabled);

          // Only update if the state is changing
          if (active !== isStreamActive) {
            setIsStreamActive(active);

            // Auto-reconnect if stream becomes inactive
            if (
              !active &&
              Date.now() - lastReconnectTime > 3000 &&
              reconnectAttempts < 3 &&
              onReconnectRequest
            ) {
              console.log(
                "Stream appears inactive, auto-reconnecting (attempt",
                reconnectAttempts + 1,
                ")"
              );
              setLastReconnectTime(Date.now());
              setReconnectAttempts((prev) => prev + 1);
              onReconnectRequest();
            }
          }
        }
      };

      // Check stream immediately and periodically
      checkStreamActivity();
      const intervalId = setInterval(checkStreamActivity, 2000);

      // Clean up interval on unmount
      return () => {
        clearInterval(intervalId);
        if (videoRef.current) {
          videoRef.current.removeEventListener("loadeddata", handleVideoLoaded);
          videoRef.current.removeEventListener("error", handleVideoError);
          videoRef.current.srcObject = null;
        }
      };
    }
  }, [
    participant.stream,
    participant.id,
    participant.isScreenSharing,
    onReconnectRequest,
    reconnectAttempts,
    isStreamActive,
    lastReconnectTime,
  ]);

  // Handle manual reconnect
  const handleReconnectClick = () => {
    console.log("User requested manual reconnection to screen share");
    if (onReconnectRequest) {
      setIsLoading(true);
      setReconnectAttempts(0);
      setLastReconnectTime(Date.now());
      onReconnectRequest();
    }
  };

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`w-full h-full object-contain bg-black transition-opacity duration-300 ${
          isLoading ? "opacity-0" : "opacity-100"
        }`}
      />

      <div className="absolute top-3 left-3 bg-gray-900 bg-opacity-70 rounded-md px-3 py-1 flex items-center gap-2">
        <ScreenShare className="h-4 w-4 text-blue-400" />
        <span className="text-sm font-medium">
          {participant.username} is sharing screen
        </span>
      </div>

      {(isLoading || !isStreamActive) && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900 bg-opacity-70">
          <div className="text-center p-4">
            {isLoading ? (
              <div>
                <div
                  className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-500 border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]"
                  role="status"
                >
                  <span className="!absolute !-m-px !h-px !w-px !overflow-hidden !whitespace-nowrap !border-0 !p-0 ![clip:rect(0,0,0,0)]">
                    Loading...
                  </span>
                </div>
                <p className="mt-2">Loading shared screen...</p>
              </div>
            ) : (
              <>
                <p className="mb-4">Screen share connection issue</p>
                <button
                  onClick={handleReconnectClick}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg"
                >
                  Reconnect
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Room;
