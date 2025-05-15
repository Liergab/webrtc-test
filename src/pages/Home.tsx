import React, { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Video,
  Users,
  Plus,
  AlertCircle,
  AlertTriangle,
  Camera,
  Mic,
} from "lucide-react";
import { generateRandomId } from "../utils/helpers";

const Home: React.FC = () => {
  const [roomId, setRoomId] = useState("");
  const [username, setUsername] = useState("");
  const [roomTitle, setRoomTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [showPermissionsPrompt, setShowPermissionsPrompt] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Check if device is mobile
  useEffect(() => {
    const mobile =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      );
    setIsMobile(mobile);
    console.log(
      "Home page - Device detected as:",
      mobile ? "mobile" : "desktop"
    );
  }, []);

  // Check for error state passed from room component on redirect
  useEffect(() => {
    if (location.state && location.state.error) {
      const { error, roomId } = location.state as {
        error: string;
        roomId: string;
      };
      setErrorMessage(`Failed to join room ${roomId}: ${error}`);
      // Clear the location state to prevent error message persisting on refresh
      window.history.replaceState({}, document.title);
    }
  }, [location]);

  // Function to request permissions on mobile before creating/joining
  const checkPermissions = async (callback: () => void) => {
    if (!isMobile) {
      // On desktop, proceed directly
      callback();
      return;
    }

    // On mobile, show permissions prompt first
    setShowPermissionsPrompt(true);

    // Pre-check if permissions are already granted
    try {
      const permissionStatus = await Promise.all([
        navigator.permissions.query({ name: "camera" as PermissionName }),
        navigator.permissions.query({ name: "microphone" as PermissionName }),
      ]);

      console.log(
        "Permission status check - Camera:",
        permissionStatus[0].state,
        "Microphone:",
        permissionStatus[1].state
      );

      // If both are already granted, we can proceed immediately
      if (
        permissionStatus[0].state === "granted" &&
        permissionStatus[1].state === "granted"
      ) {
        console.log("Permissions already granted, proceeding directly");
        setTimeout(() => {
          setShowPermissionsPrompt(false);
          callback();
        }, 100);
      }
    } catch (err) {
      console.log("Error checking permission status:", err);
      // Continue with normal flow if permission check fails
    }
  };

  // Function to test media access and then proceed
  const testMediaAndProceed = async (callback: () => void) => {
    try {
      // Try to get minimal video and audio just to test permissions
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });

      // Stop tracks immediately - we just needed the permission check
      stream.getTracks().forEach((track) => track.stop());

      // Permissions granted, proceed
      setShowPermissionsPrompt(false);

      // Add a small delay before navigation to ensure browser has processed the permissions
      setTimeout(() => {
        try {
          callback();
        } catch (navError) {
          console.error("Navigation error after permissions:", navError);
          setErrorMessage(
            "Error navigating after permissions were granted. Please try again."
          );
        }
      }, 500);
    } catch (err) {
      console.error("Permission error:", err);
      setErrorMessage(
        "Camera or microphone permission denied. Please allow access to use the app."
      );
      setShowPermissionsPrompt(false);
    }
  };

  const handleCreateRoom = () => {
    const createRoom = () => {
      const newRoomId = generateRandomId();
      const finalUsername =
        username.trim() || `Host-${Math.floor(Math.random() * 1000)}`;
      const finalTitle = roomTitle.trim() || "Untitled Meeting";
      navigate(
        `/room/${newRoomId}?isCreator=true&username=${encodeURIComponent(
          finalUsername
        )}&title=${encodeURIComponent(finalTitle)}`
      );
    };

    checkPermissions(createRoom);
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!roomId.trim()) {
      setErrorMessage("Please enter a room ID");
      return;
    }

    const joinRoom = () => {
      const finalUsername =
        username.trim() || `Guest-${Math.floor(Math.random() * 1000)}`;
      navigate(
        `/room/${roomId.trim()}?isCreator=false&username=${encodeURIComponent(
          finalUsername
        )}`
      );
    };

    checkPermissions(joinRoom);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-8">
      {/* Mobile Permissions Prompt */}
      {showPermissionsPrompt && (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md mx-4">
            <div className="flex justify-center mb-4">
              <AlertTriangle className="h-16 w-16 text-yellow-500" />
            </div>
            <h2 className="text-xl font-bold mb-4 text-center">
              Camera & Microphone Access
            </h2>
            <p className="mb-6 text-center">
              This app needs access to your camera and microphone to work
              properly. You'll be asked to grant permissions next.
            </p>
            <div className="flex flex-col space-y-2 mb-6">
              <div className="bg-gray-700 rounded-lg p-3 flex items-center">
                <Camera className="h-5 w-5 text-blue-400 mr-3" />
                <span>Camera access required</span>
              </div>
              <div className="bg-gray-700 rounded-lg p-3 flex items-center">
                <Mic className="h-5 w-5 text-blue-400 mr-3" />
                <span>Microphone access required</span>
              </div>
            </div>
            <div className="flex justify-between">
              <button
                onClick={() => setShowPermissionsPrompt(false)}
                className="bg-gray-600 hover:bg-gray-700 text-white py-2 px-4 rounded"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  testMediaAndProceed(
                    isCreating
                      ? handleCreateRoom
                      : () =>
                          handleJoinRoom({ preventDefault: () => {} } as any)
                  )
                }
                className="bg-blue-600 hover:bg-blue-700 text-white py-2 px-4 rounded"
              >
                Allow Access
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="w-full max-w-md bg-gray-800 rounded-lg shadow-xl overflow-hidden">
        <div className="bg-blue-600 p-6 flex items-center justify-center">
          <Video className="h-12 w-12 mr-4" />
          <h1 className="text-2xl font-bold">WebRTC Video Chat</h1>
        </div>

        {/* Show error message if any */}
        {errorMessage && (
          <div className="bg-red-500 text-white p-4 flex items-start">
            <AlertCircle className="h-5 w-5 mr-2 mt-0.5 flex-shrink-0" />
            <p>{errorMessage}</p>
          </div>
        )}

        <div className="p-6 space-y-6">
          <div className="mb-4">
            <label
              htmlFor="username"
              className="block text-sm font-medium text-gray-300 mb-2"
            >
              Your Name
            </label>
            <input
              type="text"
              id="username"
              placeholder="Enter your name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg py-3 px-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div className="flex flex-col space-y-4">
            <button
              onClick={() => setIsCreating(true)}
              className="flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition-all duration-300 shadow-md"
            >
              <Plus className="h-5 w-5 mr-2" />
              Create a New Room
            </button>

            {isCreating && (
              <div className="flex flex-col p-4 bg-gray-700 rounded-lg animate-fadeIn">
                <p className="text-gray-300 mb-4">
                  Ready to start your own room?
                </p>
                <div className="mb-4">
                  <label
                    htmlFor="roomTitle"
                    className="block text-sm font-medium text-gray-300 mb-2"
                  >
                    Meeting Title
                  </label>
                  <input
                    type="text"
                    id="roomTitle"
                    placeholder="Enter meeting title"
                    value={roomTitle}
                    onChange={(e) => setRoomTitle(e.target.value)}
                    className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg py-3 px-4 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>
                <button
                  onClick={handleCreateRoom}
                  className="bg-green-500 hover:bg-green-600 text-white font-medium py-3 px-4 rounded-lg transition-all duration-300"
                >
                  Start Room Now
                </button>
              </div>
            )}

            <div className="relative flex items-center">
              <div className="flex-grow border-t border-gray-600"></div>
              <span className="flex-shrink mx-4 text-gray-400">or</span>
              <div className="flex-grow border-t border-gray-600"></div>
            </div>

            <form onSubmit={handleJoinRoom} className="space-y-4">
              <div>
                <label
                  htmlFor="roomId"
                  className="block text-sm font-medium text-gray-300 mb-2"
                >
                  Join an existing room
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id="roomId"
                    placeholder="Enter room ID"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    className={`w-full bg-gray-700 text-white border ${
                      errorMessage && !roomId.trim()
                        ? "border-red-500"
                        : "border-gray-600"
                    } rounded-lg py-3 px-4 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                  />
                  <Users className="absolute right-3 top-3 h-5 w-5 text-gray-400" />
                </div>
                {errorMessage && !roomId.trim() && (
                  <p className="text-red-500 text-sm mt-1">
                    Room ID is required
                  </p>
                )}
              </div>
              <button
                type="submit"
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium py-3 px-4 rounded-lg transition-all duration-300"
              >
                Join Room
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;
