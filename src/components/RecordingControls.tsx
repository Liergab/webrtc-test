import React from "react";
import { Circle, Clock } from "lucide-react";

interface RecordingControlsProps {
  isCreator: boolean;
  isRecording: boolean;
  recordingTime: number;
  startRecording: () => void;
  stopRecording: () => void;
  canStartRecording: boolean;
  canStopRecording: boolean;
}

const RecordingControls: React.FC<RecordingControlsProps> = ({
  isCreator,
  isRecording,
  recordingTime,
  startRecording,
  stopRecording,
  canStartRecording,
  canStopRecording,
}) => {
  // Format recording time as MM:SS
  const formattedTime = () => {
    const minutes = Math.floor(recordingTime / 60);
    const seconds = recordingTime % 60;
    return `${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`;
  };

  // If user is not the creator/host, show only recording indicator
  if (!isCreator) {
    return isRecording ? (
      <div className="recording-indicator">
        <div className="indicator-dot"></div>
        <span className="indicator-text">RECORDING IN PROGRESS</span>
      </div>
    ) : null;
  }

  // For host/creator, show full recording controls
  return (
    <div className="recording-controls">
      {canStartRecording && !isRecording && (
        <button
          className="recording-button"
          onClick={startRecording}
          title="Start Recording (Browser will show 'sharing your screen' but it's actually recording)"
        >
          <Circle size={18} className="text-red-500" />
          <span>Record Screen</span>
          <div className="recording-tooltip">
            Note: Browser will show "sharing your screen" during recording
          </div>
        </button>
      )}

      {isRecording && (
        <div className="recording-status">
          <div className="recording-live">
            <div className="recording-dot"></div>
            <Clock size={16} />
            <span className="recording-timer">{formattedTime()}</span>
          </div>
          <div className="recording-label">RECORDING</div>
          {canStopRecording && (
            <button
              className="stop-recording-button"
              onClick={stopRecording}
              title="Stop Recording and Save"
            >
              <div className="h-4 w-4 flex items-center justify-center border-2 border-current">
                <div className="h-2 w-2 bg-current"></div>
              </div>
              <span>Stop & Save</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default RecordingControls;
