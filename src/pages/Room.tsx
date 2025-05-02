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
  StopCircle,
} from "lucide-react";
import { useWebRTC } from "../hooks/useWebRTC";

interface Participant {
  id: string;
  stream: MediaStream;
  isCreator: boolean;
  isScreenSharing?: boolean;
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

// Define component types at the top level
interface RemoteScreenShareProps {
  participant: Participant;
  onReconnectRequest?: () => void;
}

const Room: React.FC = () => {
  // Existing state
  const { roomId } = useParams<{ roomId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const isCreator =
    new URLSearchParams(location.search).get("isCreator") === "true";
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isCopied, setIsCopied] = useState(false);

  // Chat state
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

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
    sendDataToAll,
  } = useWebRTC({
    roomId: roomId || "",
    isCreator,
    onDataReceived: handleDataReceived,
  });

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);

  // Check if any participant is sharing screen
  const screenSharingParticipant = participants.find((p) => p.isScreenSharing);
  const isAnyoneScreenSharing = isScreenSharing || !!screenSharingParticipant;
  const [screenShareConnected, setScreenShareConnected] = useState(true);

  // Handle received data (for chat)
  function handleDataReceived(data: DataMessage) {
    if (data.type === "chat-message") {
      const chatData = data as ChatDataMessage;
      const newMessage: ChatMessage = {
        sender: chatData.sender,
        text: chatData.text,
        timestamp: chatData.timestamp,
        isFromMe: false,
      };
      setChatMessages((prev) => [...prev, newMessage]);
    }
  }

  // Send chat message
  const sendChatMessage = () => {
    if (!message.trim()) return;

    // Create message object
    const chatMessage = {
      type: "chat-message",
      sender: isCreator ? "Host" : "You",
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
      alert(`Error: ${error}. Redirecting to home page.`);
      navigate("/");
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

  // Regular check for screen sharing participant to ensure UI is in sync
  useEffect(() => {
    // Log screen sharing status changes for debugging
    console.log(
      "Screen sharing status change:",
      isScreenSharing,
      "Sharing participant:",
      screenSharingParticipant?.id
    );

    // Force update the UI when screen sharing status changes
    if (screenSharingParticipant && !isAnyoneScreenSharing) {
      console.log(
        "Detected inconsistency in screen sharing UI state, fixing..."
      );
      // This will trigger a re-render with correct sharing state
      setIsChatOpen(isChatOpen);
    }
  }, [isScreenSharing, screenSharingParticipant]);

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

  const [isTransitioning, setIsTransitioning] = useState(false);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Room header */}
      <header className="bg-gray-800 p-4 shadow-md">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center">
          <div className="flex items-center mb-3 sm:mb-0">
            <Video className="h-6 w-6 text-blue-500 mr-2" />
            <h1 className="text-xl font-bold">WebRTC Room</h1>
          </div>

          <div className="flex items-center space-x-2">
            <div className="flex items-center bg-gray-700 rounded-lg px-3 py-2">
              <Users className="h-4 w-4 text-blue-400 mr-2" />
              <span className="text-sm">
                {participants.length + 1} participants
              </span>
            </div>

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
      <main className="flex-1 p-4 sm:p-6 overflow-hidden bg-gray-900 flex">
        {/* Video grid */}
        <div
          className={`h-full ${
            isChatOpen ? "w-3/4" : "w-full"
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

          {/* If there's a screen share, display it prominently but keep all participants visible */}
          {isAnyoneScreenSharing ? (
            <div className="h-full grid gap-4 transition-all duration-500 ease-in-out screen-share-grid">
              {/* Screen share area - left side */}
              <div className="bg-gray-800 rounded-lg overflow-hidden shadow-lg">
                {isScreenSharing ? (
                  <video
                    ref={screenVideoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <RemoteScreenShare
                    participant={screenSharingParticipant!}
                    onReconnectRequest={requestScreenShareReconnect}
                  />
                )}
                <div className="absolute top-3 left-3 bg-red-500 bg-opacity-70 rounded-md px-2 py-1">
                  <span className="text-sm font-medium">
                    {isScreenSharing
                      ? "You are sharing your screen"
                      : `${
                          screenSharingParticipant?.isCreator
                            ? "Host"
                            : "Participant"
                        } is sharing screen`}
                  </span>
                </div>
              </div>

              {/* Participant videos - right side */}
              <div className="h-full overflow-y-auto">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-1 lg:grid-cols-1">
                  {/* Your video */}
                  <div className="relative bg-gray-800 rounded-lg overflow-hidden shadow-lg h-48">
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
                        <div className="h-16 w-16 rounded-full bg-gray-700 flex items-center justify-center">
                          <Users className="h-8 w-8 text-gray-500" />
                        </div>
                      </div>
                    )}

                    <div className="absolute bottom-2 left-2 bg-gray-900 bg-opacity-70 rounded-md px-2 py-1">
                      <span className="text-sm font-medium">
                        {isCreator ? "You (Host)" : "You"}
                      </span>
                    </div>

                    {!isMicOn && (
                      <div className="absolute top-2 right-2 bg-red-500 rounded-full p-1">
                        <MicOff className="h-3 w-3" />
                      </div>
                    )}
                  </div>

                  {/* All participants (including the one sharing screen) */}
                  {participants.map((participant) => (
                    <div
                      key={participant.id}
                      className="relative bg-gray-800 rounded-lg overflow-hidden shadow-lg animate-fadeIn h-48"
                    >
                      <RemoteVideo participant={participant} />
                      <div className="absolute bottom-2 left-2 bg-gray-900 bg-opacity-70 rounded-md px-2 py-1">
                        <span className="text-sm font-medium">
                          {participant.isCreator
                            ? "Host"
                            : `Participant${
                                participant.isScreenSharing ? " (Sharing)" : ""
                              }`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            // Original layout when no screen sharing
            <div className="h-full grid grid-cols-1 md:grid-cols-3 gap-4 auto-rows-fr">
              {/* If user is creator, show them first */}
              {isCreator && (
                <div className="relative bg-gray-800 rounded-lg overflow-hidden shadow-lg md:col-span-2 md:row-span-2 transition-all duration-300">
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
                      <div className="h-20 w-20 rounded-full bg-gray-700 flex items-center justify-center">
                        <Users className="h-10 w-10 text-gray-500" />
                      </div>
                    </div>
                  )}

                  <div className="absolute bottom-3 left-3 bg-gray-900 bg-opacity-70 rounded-md px-2 py-1">
                    <span className="text-sm font-medium">You (Host)</span>
                  </div>

                  {!isMicOn && (
                    <div className="absolute top-3 right-3 bg-red-500 rounded-full p-1">
                      <MicOff className="h-4 w-4" />
                    </div>
                  )}
                </div>
              )}

              {/* If user is not creator, show creator first if available */}
              {!isCreator &&
                participants
                  .filter((p) => p.isCreator)
                  .map((participant) => (
                    <div
                      key={participant.id}
                      className="relative bg-gray-800 rounded-lg overflow-hidden shadow-lg md:col-span-2 md:row-span-2 animate-fadeIn transition-all duration-300"
                    >
                      <RemoteVideo participant={participant} />
                      <div className="absolute bottom-3 left-3 bg-gray-900 bg-opacity-70 rounded-md px-2 py-1">
                        <span className="text-sm font-medium">Host</span>
                      </div>
                    </div>
                  ))}

              {/* If user is not creator, show them second */}
              {!isCreator && (
                <div className="relative bg-gray-800 rounded-lg overflow-hidden shadow-lg transition-all duration-300">
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
                      <div className="h-20 w-20 rounded-full bg-gray-700 flex items-center justify-center">
                        <Users className="h-10 w-10 text-gray-500" />
                      </div>
                    </div>
                  )}

                  <div className="absolute bottom-3 left-3 bg-gray-900 bg-opacity-70 rounded-md px-2 py-1">
                    <span className="text-sm font-medium">You</span>
                  </div>

                  {!isMicOn && (
                    <div className="absolute top-3 right-3 bg-red-500 rounded-full p-1">
                      <MicOff className="h-4 w-4" />
                    </div>
                  )}
                </div>
              )}

              {/* Show all other participants */}
              {participants
                .filter((participant) => !participant.isCreator)
                .map((participant) => (
                  <div
                    key={participant.id}
                    className="relative bg-gray-800 rounded-lg overflow-hidden shadow-lg animate-fadeIn transition-all duration-300"
                  >
                    <RemoteVideo participant={participant} />
                    <div className="absolute bottom-3 left-3 bg-gray-900 bg-opacity-70 rounded-md px-2 py-1">
                      <span className="text-sm font-medium">Participant</span>
                    </div>
                  </div>
                ))}

              {/* Empty placeholder for better grid layout when few participants */}
              {participants.length === 0 && !isCreator && (
                <div className="hidden md:block md:col-span-2 md:row-span-2"></div>
              )}
            </div>
          )}
        </div>

        {/* Chat panel */}
        {isChatOpen && (
          <div className="w-1/4 bg-gray-800 rounded-lg ml-4 flex flex-col shadow-lg animate-fadeIn">
            <div className="p-3 border-b border-gray-700 font-medium">
              <h3>Room Chat</h3>
            </div>

            {/* Messages container */}
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
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

            {/* Message input */}
            <div className="p-3 border-t border-gray-700 flex">
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
      </main>

      {/* Controls */}
      <footer className="bg-gray-800 p-4 shadow-lg">
        <div className="max-w-7xl mx-auto flex justify-center items-center space-x-4">
          <button
            onClick={handleToggleMic}
            className={`p-3 rounded-full ${
              isMicOn
                ? "bg-gray-700 hover:bg-gray-600"
                : "bg-red-500 hover:bg-red-600"
            } transition-colors duration-300`}
            aria-label={isMicOn ? "Mute microphone" : "Unmute microphone"}
          >
            {isMicOn ? (
              <Mic className="h-6 w-6" />
            ) : (
              <MicOff className="h-6 w-6" />
            )}
          </button>

          <button
            onClick={handleToggleVideo}
            className={`p-3 rounded-full ${
              isVideoOn
                ? "bg-gray-700 hover:bg-gray-600"
                : "bg-red-500 hover:bg-red-600"
            } transition-colors duration-300`}
            aria-label={isVideoOn ? "Turn off camera" : "Turn on camera"}
          >
            {isVideoOn ? (
              <Video className="h-6 w-6" />
            ) : (
              <VideoOff className="h-6 w-6" />
            )}
          </button>

          <button
            onClick={handleToggleScreenShare}
            className={`p-3 rounded-full ${
              isScreenSharing
                ? "bg-red-500 hover:bg-red-600"
                : "bg-gray-700 hover:bg-gray-600"
            } transition-colors duration-300`}
            aria-label={
              isScreenSharing ? "Stop sharing screen" : "Share screen"
            }
            disabled={screenSharingParticipant !== undefined}
            title={
              screenSharingParticipant
                ? "Someone is already sharing their screen"
                : ""
            }
          >
            {isScreenSharing ? (
              <StopCircle className="h-6 w-6" />
            ) : (
              <ScreenShare className="h-6 w-6" />
            )}
          </button>

          <button
            onClick={() => setIsChatOpen(!isChatOpen)}
            className={`p-3 rounded-full ${
              isChatOpen
                ? "bg-blue-600 hover:bg-blue-700"
                : "bg-gray-700 hover:bg-gray-600"
            } transition-colors duration-300`}
            aria-label={isChatOpen ? "Close chat" : "Open chat"}
          >
            <MessageSquare className="h-6 w-6" />
          </button>

          <button
            onClick={handleLeaveRoom}
            className="p-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors duration-300"
            aria-label="Leave call"
          >
            <Phone className="h-6 w-6 transform rotate-135" />
          </button>
        </div>
      </footer>
    </div>
  );
};

// Component for remote participant video
const RemoteVideo: React.FC<{ participant: Participant }> = ({
  participant,
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
              <Users className="h-8 w-8 text-gray-500" />
            </div>
          )}
        </div>
      )}

      {participant.isScreenSharing && (
        <div
          className="absolute top-2 right-2 bg-blue-500 rounded-full p-1"
          title="This participant is sharing their screen"
        >
          <ScreenShare className="h-3 w-3" />
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
