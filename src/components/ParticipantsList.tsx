import React from "react";
import { Users, Crown, ScreenShare, Mic, MicOff } from "lucide-react";

interface Participant {
  id: string;
  username: string;
  isCreator: boolean;
  isScreenSharing?: boolean;
  isMuted?: boolean;
}

interface ParticipantsListProps {
  participants: Participant[];
  currentUser: {
    username: string;
    isCreator: boolean;
  };
  onPinParticipant: (id: string) => void;
  pinnedParticipantId: string | null;
}

const ParticipantsList: React.FC<ParticipantsListProps> = ({
  participants,
  currentUser,
  onPinParticipant,
  pinnedParticipantId,
}) => {
  // Combine current user with participants
  const allParticipants = [
    {
      id: "local",
      username: currentUser.username,
      isCreator: currentUser.isCreator,
      isScreenSharing: false,
      isMuted: false,
      isLocal: true,
    },
    ...participants.map((p) => ({ ...p, isLocal: false })),
  ];

  return (
    <div className="participants-list bg-gray-800 rounded-lg overflow-hidden">
      <div className="p-3 border-b border-gray-700 font-medium flex items-center">
        <Users className="mr-2 h-4 w-4" />
        <h3>Participants ({allParticipants.length})</h3>
      </div>

      <div className="p-2 max-h-[300px] overflow-y-auto">
        {allParticipants.map((participant) => (
          <div
            key={participant.id}
            className={`flex items-center justify-between p-2 rounded-md mb-1 hover:bg-gray-700 cursor-pointer transition-colors ${
              pinnedParticipantId === participant.id
                ? "bg-blue-900 bg-opacity-30"
                : ""
            }`}
            onClick={() => onPinParticipant(participant.id)}
          >
            <div className="flex items-center">
              <div className="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center mr-2">
                {participant.username.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="flex items-center">
                  <span className="font-medium">
                    {participant.isLocal
                      ? `${participant.username} (You)`
                      : participant.username}
                  </span>
                  {participant.isCreator && (
                    <Crown className="h-3 w-3 ml-1 text-yellow-400" />
                  )}
                </div>
                {pinnedParticipantId === participant.id && (
                  <span className="text-xs text-blue-400">Pinned</span>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-2">
              {participant.isScreenSharing && (
                <div className="text-blue-400" title="Sharing screen">
                  <ScreenShare className="h-4 w-4" />
                </div>
              )}
              {participant.isMuted && (
                <div className="text-red-400" title="Muted">
                  <MicOff className="h-4 w-4" />
                </div>
              )}
              {!participant.isMuted && (
                <div className="text-green-400" title="Unmuted">
                  <Mic className="h-4 w-4" />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ParticipantsList;
