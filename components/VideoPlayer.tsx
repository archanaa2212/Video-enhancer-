import React, { useRef, useState, useEffect, useCallback } from 'react';

interface VideoPlayerProps {
  file: File;
}

const formatTime = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
};

const VideoPlayer: React.FC<VideoPlayerProps> = ({ file }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null); // Reference to the off-screen video element
  const canvasRef = useRef<HTMLCanvasElement>(null); // Reference to the visible canvas element
  const animationFrameId = useRef<number | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hasVideoLoaded, setHasVideoLoaded] = useState(false); // To check if video metadata is loaded

  const drawFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video && canvas && !video.paused && !video.ended) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Clear the canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Draw the video frame
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
    }
    animationFrameId.current = requestAnimationFrame(drawFrame);
  }, []);

  const handlePlayPause = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      if (isPlaying) {
        video.pause();
        if (animationFrameId.current) {
          cancelAnimationFrame(animationFrameId.current);
          animationFrameId.current = null;
        }
      } else {
        video.play();
        if (!animationFrameId.current) {
          animationFrameId.current = requestAnimationFrame(drawFrame);
        }
      }
      setIsPlaying(!isPlaying);
    }
  }, [isPlaying, drawFrame]);

  const handleMuteUnmute = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  }, [isMuted]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      setCurrentTime(video.currentTime);
    }
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video && canvas) {
      setDuration(video.duration);
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      setHasVideoLoaded(true);
      // Draw initial frame
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
    }
  }, []);

  const handleVideoEnd = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    if (animationFrameId.current) {
      cancelAnimationFrame(animationFrameId.current);
      animationFrameId.current = null;
    }
  }, []);

  useEffect(() => {
    // Clean up any existing animation frame
    if (animationFrameId.current) {
      cancelAnimationFrame(animationFrameId.current);
      animationFrameId.current = null;
    }

    // Reset states
    setIsPlaying(false);
    setIsMuted(false);
    setCurrentTime(0);
    setDuration(0);
    setHasVideoLoaded(false);

    // Create an off-screen video element
    const videoElement = document.createElement('video');
    videoRef.current = videoElement;
    videoElement.preload = 'metadata';
    videoElement.muted = true; // Start muted
    setIsMuted(true);

    // Attach event listeners
    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    videoElement.addEventListener('ended', handleVideoEnd);

    let objectURL: string | null = null;
    if (file) {
      objectURL = URL.createObjectURL(file);
      videoElement.src = objectURL;
    }

    return () => {
      // Clean up event listeners
      if (videoRef.current) {
        videoRef.current.removeEventListener('timeupdate', handleTimeUpdate);
        videoRef.current.removeEventListener('loadedmetadata', handleLoadedMetadata);
        videoRef.current.removeEventListener('ended', handleVideoEnd);
      }
      // Revoke object URL
      if (objectURL) {
        URL.revokeObjectURL(objectURL);
      }
      // Clean up animation frame
      if (animationFrameId.current) {
        cancelAnimationFrame(animationFrameId.current);
      }
      // Clear canvas
      if (canvasRef.current && canvasRef.current.getContext('2d')) {
        canvasRef.current.getContext('2d')?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
      videoRef.current = null; // Detach ref
    };
  }, [file, handleTimeUpdate, handleLoadedMetadata, handleVideoEnd, drawFrame]);

  // Render for local files using canvas
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center bg-gray-900 rounded-lg overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full object-contain"
        onClick={handlePlayPause}
        aria-label="Video playback area"
      >
        Your browser does not support the canvas tag.
      </canvas>

      {/* Video Controls Overlay */}
      {hasVideoLoaded && (
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent flex flex-col gap-2">
          {/* Progress Bar */}
          <div className="relative w-full h-1 bg-gray-700 rounded-full">
            <div
              className="absolute top-0 left-0 h-full bg-blue-500 rounded-full"
              style={{ width: `${(currentTime / duration) * 100}%` }}
              role="progressbar"
              aria-valuenow={currentTime}
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-label="Video progress"
            ></div>
          </div>

          {/* Play/Mute Controls and Time Display */}
          <div className="flex justify-between items-center w-full">
            {/* Left Group: Play/Pause & Mute/Unmute */}
            <div className="flex gap-2">
              <button
                onClick={handlePlayPause}
                className="bg-white/20 hover:bg-white/30 text-white p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-black transition-colors duration-200 shadow-md"
                aria-label={isPlaying ? 'Pause video' : 'Play video'}
              >
                {isPlaying ? (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
              <button
                onClick={handleMuteUnmute}
                className="bg-white/20 hover:bg-white/30 text-white p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-black transition-colors duration-200 shadow-md"
                aria-label={isMuted ? 'Unmute video' : 'Mute video'}
              >
                {isMuted ? (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .9-.2 1.74-.54 2.5l1.69 1.69C19.73 14.63 20 13.38 20 12c0-4.28-2.95-7.86-7-8.77v2.06c2.83.85 4.98 3.53 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5V9L4.27 3zm10.74 11.25l-2.73-2.73L12 9v4.18l2.99 2.99c.01-.01.01-.01.01-.02z"/>
                  </svg>
                ) : (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 12L9.91 7.91 10 7.91 10 16.09 16 12 14 12z"/>
                  </svg>
                )}
              </button>
            </div>

            {/* Right Group: Time Display */}
            <div className="text-white text-sm font-semibold">
              {formatTime(currentTime)} / {formatTime(duration)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;