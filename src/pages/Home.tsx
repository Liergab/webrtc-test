import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Video, Users, Plus } from "lucide-react";
import { generateRandomId } from "../utils/helpers";

const Home: React.FC = () => {
  const [roomId, setRoomId] = useState("");
  const [username, setUsername] = useState("");
  const [roomTitle, setRoomTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const navigate = useNavigate();

  const handleCreateRoom = () => {
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

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) {
      const finalUsername =
        username.trim() || `Guest-${Math.floor(Math.random() * 1000)}`;
      navigate(
        `/room/${roomId.trim()}?isCreator=false&username=${encodeURIComponent(
          finalUsername
        )}`
      );
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-md bg-gray-800 rounded-lg shadow-xl overflow-hidden">
        <div className="bg-blue-600 p-6 flex items-center justify-center">
          <Video className="h-12 w-12 mr-4" />
          <h1 className="text-2xl font-bold">WebRTC Video Chat</h1>
        </div>

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
                    className="w-full bg-gray-700 text-white border border-gray-600 rounded-lg py-3 px-4 pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <Users className="absolute right-3 top-3 h-5 w-5 text-gray-400" />
                </div>
              </div>
              <button
                type="submit"
                disabled={!roomId.trim()}
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
