import React, { useRef, useEffect, useState } from 'react';
import { FilterState, ProcessingMode, ExportConfig } from './types';
import { Upload, Play, Pause, Download, Loader2, Undo2, Volume2, VolumeX, AlertCircle, X, CheckCircle2, ZoomIn, ZoomOut, RotateCcw, Move, Wand2, Sparkles, ChevronDown, MonitorPlay, SplitSquareHorizontal, Eye } from 'lucide-react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

type AppStep = 'upload' | 'original' | 'enhanced';
type ResolutionOption = 'original' | '1080p' | '2k' | '4k';

const App: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const exportCanvasRef = useRef<HTMLCanvasElement>(null);
  const tempCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // State Refs for Render Loop
  const stepRef = useRef<AppStep>('upload');
  const isEnhancedRef = useRef<boolean>(false);
  const isComparingRef = useRef<boolean>(false); // Ref for immediate render loop access
  const isExportingRef = useRef<boolean>(false);
  
  // Zoom & Pan Refs
  const zoomRef = useRef<number>(1);
  const panRef = useRef<{x: number, y: number}>({ x: 0, y: 0 });
  
  // Audio Context Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  
  // Rendering Loop Refs
  const animationFrameIdRef = useRef<number | null>(null);
  const videoCallbackIdRef = useRef<number | null>(null);
  
  // Workflow State
  const [step, setStep] = useState<AppStep>('upload');
  const [isEnhanced, setIsEnhanced] = useState(false);
  const [isComparing, setIsComparing] = useState(false); // State for UI
  
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [originalFile, setOriginalFile] = useState<File | null>(null); 
  const [originalFileName, setOriginalFileName] = useState<string>('video');
  const [mode, setMode] = useState<ProcessingMode>(ProcessingMode.IDLE);
  
  const [isMuted, setIsMuted] = useState(false);
  
  // Zoom State
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{x: number, y: number}>({ x: 0, y: 0 });
  const isDraggingRef = useRef<boolean>(false);
  const lastMousePosRef = useRef<{x: number, y: number}>({ x: 0, y: 0 });
  
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Export State
  const [showExportMenu, setShowExportMenu] = useState(false);

  // FFmpeg State
  const ffmpegRef = useRef<FFmpeg | null>(null);
  
  // Export Summary State
  const [exportSummary, setExportSummary] = useState<{
      show: boolean;
      filename: string;
      size: string;
      duration: string;
      resolution: string;
      fps: number;
  } | null>(null);

  const [loading, setLoading] = useState<{
      active: boolean;
      message: string;
      progress: number;
      subtext?: string;
  }>({ active: false, message: '', progress: 0 });

  // Init temp canvas for fast blur
  useEffect(() => {
    if (!tempCanvasRef.current) {
        tempCanvasRef.current = document.createElement('canvas');
    }
  }, []);

  // Sync state to ref for render loop immediately
  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => { isEnhancedRef.current = isEnhanced; }, [isEnhanced]);
  useEffect(() => { isComparingRef.current = isComparing; }, [isComparing]);

  // Sync Zoom/Pan refs
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  // Cleanup
  useEffect(() => {
    return () => {
        isExportingRef.current = false;
        if (videoSrc) URL.revokeObjectURL(videoSrc);
        if (videoCallbackIdRef.current && videoRef.current && 'cancelVideoFrameCallback' in videoRef.current) {
            // @ts-ignore
            videoRef.current.cancelVideoFrameCallback(videoCallbackIdRef.current);
        }
        if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
    };
  }, [videoSrc]);

  // Load FFmpeg
  const loadFFmpeg = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    
    const ffmpeg = new FFmpeg();
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    
    try {
        await ffmpeg.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
        ffmpegRef.current = ffmpeg;
        return ffmpeg;
    } catch (error) {
        console.error("Failed to load FFmpeg:", error);
        throw new Error("Failed to load video processing engine. Please check your connection.");
    }
  };

  // Core Rendering Function
  const renderToCanvas = (
      canvas: HTMLCanvasElement, 
      source: CanvasImageSource, // Can be HTMLVideoElement or ImageBitmap
      isExport: boolean, 
      sourceWidth: number,
      sourceHeight: number,
      forceW?: number, 
      forceH?: number, 
      overrideEnhance?: boolean
  ) => {
      const ctx = canvas.getContext('2d', { alpha: false }); 
      if (!ctx) return;
      
      // Determine if we should apply filters. 
      // Logic: Apply if (Enhanced is ON) AND (We are NOT comparing/peeking original)
      const shouldApplyFilters = (overrideEnhance !== undefined ? overrideEnhance : isEnhancedRef.current) && !isComparingRef.current;
      
      let targetWidth = sourceWidth;
      let targetHeight = sourceHeight;

      if (forceW && forceH) {
          targetWidth = forceW;
          targetHeight = forceH;
      } else {
          if (!isExport) {
             const MAX_PREVIEW_WIDTH = 1920; 
             if (targetWidth > MAX_PREVIEW_WIDTH) {
                 const ratio = MAX_PREVIEW_WIDTH / targetWidth;
                 targetWidth = MAX_PREVIEW_WIDTH;
                 targetHeight = targetHeight * ratio;
             }
          }
      }
      
      targetWidth = Math.floor(targetWidth);
      targetHeight = Math.floor(targetHeight);
      
      // Ensure dimensions are even for video encoding requirements (FFmpeg likes evens)
      if (targetWidth % 2 !== 0) targetWidth--;
      if (targetHeight % 2 !== 0) targetHeight--;

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
          canvas.width = targetWidth;
          canvas.height = targetHeight;
      }
      
      ctx.save();
      
      // ZOOM & PAN TRANSFORM (Preview Only)
      if (!isExport) {
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          const z = zoomRef.current;
          const p = panRef.current;
          
          ctx.translate(canvas.width / 2, canvas.height / 2);
          ctx.scale(z, z);
          ctx.translate(-canvas.width / 2 + p.x, -canvas.height / 2 + p.y);
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // --- FILTER PIPELINE ---
      if (shouldApplyFilters) {
          if (tempCanvasRef.current) {
              const downsampleFactor = 2;
              const tempW = Math.max(64, Math.floor(canvas.width / downsampleFactor));
              const tempH = Math.max(64, Math.floor(canvas.height / downsampleFactor));

              if (tempCanvasRef.current.width !== tempW || tempCanvasRef.current.height !== tempH) {
                  tempCanvasRef.current.width = tempW;
                  tempCanvasRef.current.height = tempH;
              }

              const tCtx = tempCanvasRef.current.getContext('2d', { alpha: false });
              if (tCtx) {
                  tCtx.drawImage(source, 0, 0, tempW, tempH);
                  tCtx.filter = 'blur(8px)'; 
                  tCtx.drawImage(tempCanvasRef.current, 0, 0, tempW, tempH);
                  tCtx.filter = 'none';

                  // 1. Base Layer
                  ctx.filter = 'saturate(115%) brightness(108%)';
                  ctx.drawImage(tempCanvasRef.current, 0, 0, canvas.width, canvas.height);
                  ctx.filter = 'none';

                  // 2. Luma/Detail
                  ctx.globalCompositeOperation = 'luminosity';
                  ctx.filter = 'url(#sharpen-hd) contrast(105%)'; 
                  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
                  ctx.filter = 'none';
                  
                  // 3. Skin Tone
                  ctx.globalCompositeOperation = 'soft-light';
                  ctx.fillStyle = 'rgba(240, 248, 255, 0.18)'; 
                  ctx.fillRect(0, 0, canvas.width, canvas.height);

                  // 4. Glow
                  ctx.globalCompositeOperation = 'screen';
                  ctx.globalAlpha = 0.25; 
                  ctx.drawImage(tempCanvasRef.current, 0, 0, canvas.width, canvas.height);

                  // 5. Contrast
                  ctx.globalCompositeOperation = 'soft-light';
                  ctx.globalAlpha = 0.25; 
                  ctx.drawImage(tempCanvasRef.current, 0, 0, canvas.width, canvas.height);

                  // 6. Clarity
                  ctx.globalCompositeOperation = 'overlay';
                  ctx.globalAlpha = 0.15;
                  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

                  ctx.globalAlpha = 1.0;
                  ctx.globalCompositeOperation = 'source-over';
              }
          } else {
              ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
          }
      } else {
          // Standard Raw Draw (Used for Original View or Compare)
          ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
          
          // If in comparison mode, maybe add a small "Original" badge?
          if (isComparingRef.current && !isExport) {
             ctx.fillStyle = "rgba(0,0,0,0.5)";
             ctx.fillRect(20, 20, 100, 30);
             ctx.fillStyle = "white";
             ctx.font = "bold 16px sans-serif";
             ctx.fillText("ORIGINAL", 30, 41);
          }
      }
      
      ctx.restore();
  };

  const startRenderLoop = () => {
    if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);

    const loop = () => {
      if (videoRef.current && canvasRef.current) {
        renderToCanvas(
            canvasRef.current, 
            videoRef.current, 
            false, 
            videoRef.current.videoWidth, 
            videoRef.current.videoHeight
        );
      }
      animationFrameIdRef.current = requestAnimationFrame(loop);
    };
    loop();
  };

  const formatTime = (seconds: number) => {
      if (isNaN(seconds)) return "00:00";
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const getAudioContext = () => {
      if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
      return audioCtxRef.current;
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setErrorMsg(null); 
    setExportSummary(null);

    if (file) {
      if (videoSrc) URL.revokeObjectURL(videoSrc);
      
      if (file.size > 2 * 1024 * 1024 * 1024) {
          setErrorMsg("File size exceeds 2GB limit. Please choose a smaller file.");
          event.target.value = '';
          return;
      }

      setOriginalFile(file);
      const fileNameWithoutExt = file.name.split('.').slice(0, -1).join('.');
      setOriginalFileName(fileNameWithoutExt);
      
      setLoading({ active: true, message: 'Loading Video', progress: 30, subtext: 'Preparing workspace...' });

      const url = URL.createObjectURL(file);
      setVideoSrc(url);
      
      setStep('original');
      setMode(ProcessingMode.IDLE); 
      setZoom(1); setPan({x: 0, y: 0}); 
      setIsMuted(false); 
      setIsEnhanced(false); 
      setCurrentTime(0); setDuration(0);
      
      if (audioCtxRef.current) {
          audioCtxRef.current.close().then(() => { audioCtxRef.current = null; audioSourceRef.current = null; });
      }

      setTimeout(() => setLoading(prev => ({...prev, progress: 100})), 800);
      setTimeout(() => setLoading(prev => ({...prev, active: false})), 1000);
    }
    event.target.value = '';
  };

  const handleMetadataLoaded = () => {
      if (videoRef.current) {
          const vidDuration = videoRef.current.duration;
          if (vidDuration > 61) {
              setVideoSrc(null);
              setStep('upload'); 
              setLoading({ active: false, message: '', progress: 0 });
              setErrorMsg("Video length exceeds 1 minute limit. Please choose a shorter video.");
              return;
          }
          setDuration(vidDuration);
      }
  };

  const handleTimeUpdate = () => {
      if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
  };
  
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
      const time = Number(e.target.value);
      if (videoRef.current) {
          videoRef.current.currentTime = time;
          setCurrentTime(time);
      }
  };

  const handleVideoLoaded = () => {
     startRenderLoop();
     try {
        const ctx = getAudioContext();
        if (!audioSourceRef.current && videoRef.current) {
            audioSourceRef.current = ctx.createMediaElementSource(videoRef.current);
            audioSourceRef.current.connect(ctx.destination);
        }
     } catch (e) { console.error("Audio Context Init Failed", e); }
     
     if (videoRef.current) {
        const playPromise = videoRef.current.play();
        if (playPromise !== undefined) {
            playPromise.then(() => setMode(ProcessingMode.PLAYING))
                .catch(() => setMode(ProcessingMode.PAUSED));
        }
     }
  };

  const togglePlay = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!videoRef.current) return;
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume();
    
    if (videoRef.current.paused) {
      videoRef.current.play()
        .then(() => setMode(ProcessingMode.PLAYING))
        .catch(() => setMode(ProcessingMode.PAUSED));
    } else {
      videoRef.current.pause();
      setMode(ProcessingMode.PAUSED);
    }
  };

  const toggleMute = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!videoRef.current) return;
    videoRef.current.muted = !videoRef.current.muted;
    setIsMuted(videoRef.current.muted);
  };
  
  const toggleEnhance = () => setIsEnhanced(prev => !prev);

  // --- ZOOM & PAN HANDLERS ---
  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newZoom = Math.min(zoomRef.current + 0.5, 4);
    setZoom(newZoom);
    zoomRef.current = newZoom;
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newZoom = Math.max(zoomRef.current - 0.5, 1);
    setZoom(newZoom);
    zoomRef.current = newZoom;
    if (newZoom === 1) {
        setPan({x: 0, y: 0});
        panRef.current = {x: 0, y: 0};
    }
  };

  const handleZoomReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    setZoom(1);
    zoomRef.current = 1;
    setPan({x: 0, y: 0});
    panRef.current = {x: 0, y: 0};
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoomRef.current > 1) {
        isDraggingRef.current = true;
        lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    e.preventDefault();
    const dx = e.clientX - lastMousePosRef.current.x;
    const dy = e.clientY - lastMousePosRef.current.y;
    const z = zoomRef.current;
    
    const newPan = {
        x: panRef.current.x + (dx / z),
        y: panRef.current.y + (dy / z)
    };
    
    setPan(newPan);
    panRef.current = newPan;
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  const handleMouseLeave = () => {
    isDraggingRef.current = false;
  };

  // --- MEDIA RECORDER + FFMPEG EXPORT LOGIC ---
  const startExportProcess = async (resolutionChoice: ResolutionOption) => {
    if (!videoRef.current || !exportCanvasRef.current) return;
    const video = videoRef.current;
    
    setShowExportMenu(false);
    setMode(ProcessingMode.EXPORTING);
    isExportingRef.current = true;
    
    setLoading({ active: true, message: 'Loading Encoder...', progress: 10, subtext: 'Initializing FFmpeg engine...' });

    // 1. Load FFmpeg
    let ffmpeg: FFmpeg;
    try {
        ffmpeg = await loadFFmpeg();
    } catch (e) {
        setErrorMsg("Failed to load FFmpeg. Check internet connection.");
        setLoading({ active: false, message: '', progress: 0 });
        setMode(ProcessingMode.PAUSED);
        isExportingRef.current = false;
        return;
    }

    setLoading({ active: true, message: 'Capturing Video...', progress: 0, subtext: 'Recording enhanced output...' });

    // 2. Configure Resolution
    let targetWidth = 1920;
    let targetHeight = 1080;
    const aspect = video.videoWidth / video.videoHeight;

    if (resolutionChoice === '4k') {
        targetWidth = 3840; targetHeight = 2160;
    } else if (resolutionChoice === '2k') {
        targetWidth = 2048; targetHeight = 1080; // Cinema 2K per user request
    } else if (resolutionChoice === '1080p') {
        targetWidth = 1920; targetHeight = 1080;
    } else {
        targetWidth = video.videoWidth; targetHeight = video.videoHeight;
    }

    // Adjust for Aspect Ratio
    if (Math.abs(aspect - (targetWidth / targetHeight)) > 0.05) {
        targetHeight = Math.round(targetWidth / aspect);
    }
    // Ensure Even Dimensions
    if (targetWidth % 2 !== 0) targetWidth--;
    if (targetHeight % 2 !== 0) targetHeight--;

    exportCanvasRef.current.width = targetWidth;
    exportCanvasRef.current.height = targetHeight;

    // 3. Prepare for Recording
    const wasMuted = video.muted;
    const originalCurrentTime = video.currentTime;
    video.muted = false; // Unmute to capture audio if possible (MediaRecorder might capture tab audio only if stream has audio tracks)
    // Actually, capturing audio from <video> into MediaRecorder via captureStream isn't fully reliable cross-browser. 
    // We will focus on video capture and mux audio if needed, but MediaRecorder usually handles <canvas> captureStream + AudioTrack.
    // For simplicity and robustness with FFmpeg, let's capture video visual primarily.
    
    video.currentTime = 0;
    await new Promise(r => setTimeout(r, 200)); // Buffer settlement

    // 4. Setup MediaRecorder
    const stream = exportCanvasRef.current.captureStream(30); // 30 FPS Capture
    
    // Add audio track if available
    // Note: capturing audio from the video element directly to the stream is tricky.
    // We'll rely on visual capture for now to ensure stability, or try to create a stream from video and mix.
    // Simplifying: Silent Video Capture, then we mux original audio? 
    // Or just let user know audio might be missing in preview capture.
    // Better: Capture pure video, let FFmpeg merge original audio file if needed.
    // For now, let's just capture the canvas stream.
    
    // Select supported mimeType
    let mimeType = 'video/webm;codecs=vp9';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) mimeType = 'video/webm;codecs=vp8';
    // Some browsers support mp4 direct
    if (MediaRecorder.isTypeSupported('video/mp4')) mimeType = 'video/mp4';

    const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 25000000 // 25 Mbps High Quality
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };

    const stopPromise = new Promise<void>(resolve => {
        recorder.onstop = () => resolve();
    });

    // 5. Start Recording Loop
    recorder.start();
    try {
        await video.play();
    } catch (e) {
        console.error("Play failed during export", e);
    }

    // Render loop specifically for export
    const exportRenderLoop = () => {
        if (!isExportingRef.current) return;
        if (video.ended) {
            recorder.stop();
            return;
        }
        
        renderToCanvas(
            exportCanvasRef.current!, 
            video, 
            true, 
            video.videoWidth, 
            video.videoHeight, 
            targetWidth, 
            targetHeight
        );
        
        const progress = (video.currentTime / video.duration) * 100;
        setLoading(prev => ({ ...prev, progress: Math.min(90, progress) })); // Cap at 90 until processing
        
        requestAnimationFrame(exportRenderLoop);
    };
    exportRenderLoop();

    // Wait for record to finish
    await stopPromise;
    video.pause();

    if (!isExportingRef.current) {
        // User cancelled
        video.muted = wasMuted;
        video.currentTime = originalCurrentTime;
        return;
    }

    setLoading({ active: true, message: 'Processing Video...', progress: 95, subtext: 'Converting with FFmpeg...' });

    // 6. FFmpeg Processing
    const blob = new Blob(chunks, { type: mimeType });
    const fileExt = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const inputName = `input.${fileExt}`;
    const outputName = `output.mp4`;

    try {
        // Write input file
        await ffmpeg.writeFile(inputName, await fetchFile(blob));

        // Command: Convert to MP4 (H.264). 
        // -preset ultrafast for speed (WASM is slow)
        // -crf 23 for quality
        // -pix_fmt yuv420p for compatibility
        await ffmpeg.exec([
            '-i', inputName,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '22',
            '-pix_fmt', 'yuv420p',
            outputName
        ]);

        // Read output
        const data = await ffmpeg.readFile(outputName);
        const outBlob = new Blob([data], { type: 'video/mp4' });
        const outUrl = URL.createObjectURL(outBlob);

        // Download
        const a = document.createElement('a');
        a.href = outUrl;
        a.download = `${originalFileName}_enhanced_${resolutionChoice}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setExportSummary({
            show: true,
            filename: `${originalFileName}.mp4`,
            size: `${(outBlob.size / 1024 / 1024).toFixed(2)} MB`,
            duration: formatTime(duration),
            resolution: `${targetWidth}x${targetHeight}`,
            fps: 30
        });

        // Cleanup FFmpeg files
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);

    } catch (e) {
        console.error("FFmpeg error", e);
        setErrorMsg("Video conversion failed. Please try a shorter video or lower resolution.");
    } finally {
        video.muted = wasMuted;
        video.currentTime = originalCurrentTime;
        setLoading(prev => ({ ...prev, active: false }));
        setMode(ProcessingMode.PAUSED);
        isExportingRef.current = false;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-800 font-sans overflow-hidden selection:bg-indigo-100 selection:text-indigo-900">
      
      {/* FILTER DEFINITIONS */}
      <svg style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
        <defs>
          <filter id="sharpen-hd">
            <feConvolveMatrix 
              order="3" 
              kernelMatrix="0 -0.08 0 -0.08 1.32 -0.08 0 -0.08 0" 
              edgeMode="duplicate"
              preserveAlpha="true"
            />
          </filter>
        </defs>
      </svg>

      {/* BACKGROUND ELEMENTS */}
      <div className="fixed inset-0 z-0 pointer-events-none opacity-60">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-purple-200/40 rounded-full blur-[120px] animate-pulse"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-200/40 rounded-full blur-[120px] animate-pulse" style={{animationDelay: '2s'}}></div>
        <div className="absolute top-[20%] right-[20%] w-[30%] h-[30%] bg-pink-200/30 rounded-full blur-[100px] animate-pulse" style={{animationDelay: '4s'}}></div>
      </div>

       {/* ERROR TOAST */}
       {errorMsg && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-50 bg-white/90 backdrop-blur-md border border-red-100 text-red-600 px-6 py-3 rounded-full flex items-center gap-3 text-sm shadow-xl shadow-red-500/10 animate-in fade-in slide-in-from-top-4">
          <AlertCircle size={18} /> <span className="font-medium">{errorMsg}</span> 
          <button onClick={() => setErrorMsg(null)} className="ml-2 hover:bg-red-50 rounded-full p-1 transition-colors"><X size={14} /></button>
        </div>
      )}

      {/* LOADING OVERLAY */}
      {loading.active && (
        <div className="absolute inset-0 z-50 bg-white/80 backdrop-blur-md flex flex-col items-center justify-center">
          <div className="relative mb-6">
             <div className="absolute inset-0 bg-indigo-500/20 blur-xl rounded-full"></div>
             <Loader2 size={56} className="animate-spin text-indigo-600 relative z-10" strokeWidth={1.5} />
          </div>
          <p className="font-bold text-2xl tracking-tight text-slate-900 mb-2">{loading.message}</p>
          {loading.subtext && <p className="text-slate-500 font-medium">{loading.subtext}</p>}
          <div className="w-72 h-1.5 bg-slate-200 rounded-full mt-8 overflow-hidden">
             <div className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 transition-all duration-300 ease-out" style={{ width: `${loading.progress}%` }}></div>
          </div>
        </div>
      )}

      {/* EXPORT SUMMARY */}
      {exportSummary && exportSummary.show && (
         <div className="absolute inset-0 z-50 bg-white/90 backdrop-blur-xl flex items-center justify-center p-4">
             <div className="bg-white border border-slate-100 rounded-[2rem] p-10 max-w-md w-full shadow-2xl shadow-indigo-500/10 relative overflow-hidden transform transition-all animate-in zoom-in-95 duration-300">
                 <div className="flex flex-col items-center text-center">
                     <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center mb-6 text-green-500 ring-8 ring-green-50/50"> <CheckCircle2 size={40} strokeWidth={1.5} /> </div>
                     <h3 className="text-3xl font-bold text-slate-900 mb-2 tracking-tight">Export Complete!</h3>
                     <p className="text-slate-500 mb-8">Your video has been exported.</p>
                     <div className="w-full bg-slate-50 rounded-2xl p-5 mb-8 space-y-4 border border-slate-100/50">
                         <div className="flex justify-between items-center text-sm"> <span className="text-slate-400 font-medium">Filename</span> <span className="text-slate-700 font-bold truncate max-w-[180px]">{exportSummary.filename}</span> </div>
                         <div className="flex justify-between items-center text-sm"> <span className="text-slate-400 font-medium">Size</span> <span className="text-slate-700 font-bold">{exportSummary.size}</span> </div>
                         <div className="flex justify-between items-center text-sm"> <span className="text-slate-400 font-medium">Duration</span> <span className="text-slate-700 font-bold">{exportSummary.duration}</span> </div>
                         <div className="flex justify-between items-center text-sm"> <span className="text-slate-400 font-medium">Resolution</span> <span className="text-slate-700 font-bold">{exportSummary.resolution}</span> </div>
                     </div>
                     <button onClick={() => setExportSummary(null)} className="w-full py-4 bg-slate-900 text-white font-bold rounded-2xl hover:bg-slate-800 transition-all shadow-lg shadow-slate-900/20 active:scale-95"> Process Another Video </button>
                 </div>
             </div>
         </div>
      )}

      {/* MAIN CONTENT */}
      {step === 'upload' ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 relative z-10">
             <div className="text-center mb-12">
                 <h1 className="text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-purple-600 mb-4 tracking-tight pb-2">Video Player.</h1>
                 <p className="text-xl text-slate-500 max-w-lg mx-auto leading-relaxed">Upload and play your high-quality videos.</p>
             </div>
             
             <div 
                className="w-full max-w-2xl aspect-video bg-white/60 backdrop-blur-xl border-2 border-dashed border-indigo-200 rounded-[2rem] flex flex-col items-center justify-center cursor-pointer hover:border-indigo-500 hover:bg-white/80 transition-all duration-300 group shadow-2xl shadow-indigo-100/50"
                onClick={() => fileInputRef.current?.click()}
             >
                <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center mb-6 shadow-xl shadow-indigo-100 group-hover:scale-110 transition-transform duration-300">
                    <Upload size={32} className="text-indigo-600" />
                </div>
                <h3 className="text-2xl font-bold text-slate-800 mb-2">Drop your video here</h3>
                <p className="text-slate-500 font-medium">MP4, WebM, MOV &middot; Up to 2GB</p>
                <input ref={fileInputRef} type="file" accept="video/mp4,video/webm,video/quicktime" className="hidden" onChange={handleFileChange} />
             </div>
        </div>
      ) : (
        <>
            {/* HEADER */}
            <div className="flex-none px-8 py-6 flex items-center justify-between z-30 pointer-events-none">
                <div className="pointer-events-auto bg-white/80 backdrop-blur-md px-4 py-2 rounded-full border border-white/20 shadow-sm flex items-center gap-3">
                     <button 
                        onClick={() => { 
                             setVideoSrc(null); setStep('upload'); setOriginalFileName('video');
                        }} 
                        className="text-slate-400 hover:text-slate-900 transition-colors p-1"
                        title="Back"
                     > 
                        <Undo2 size={20}/> 
                     </button>
                     
                     <div className="h-4 w-px bg-slate-200"></div>
                     <span className="text-sm font-bold text-slate-700 truncate max-w-[200px]">{originalFileName}</span>
                </div>
                
                <div className="pointer-events-auto relative">
                     <button 
                        onClick={() => setShowExportMenu(!showExportMenu)}
                        className="flex items-center gap-2 bg-slate-900 text-white px-4 py-2 rounded-full text-xs font-bold hover:bg-slate-800 transition-all shadow-lg shadow-slate-900/20 active:scale-95"
                     > 
                        <Download size={14} /> Download <ChevronDown size={14} className={showExportMenu ? 'rotate-180 transition-transform' : 'transition-transform'}/>
                     </button>
                     
                     {showExportMenu && (
                        <div className="absolute top-full right-0 mt-2 w-48 bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden animate-in fade-in slide-in-from-top-2 p-1 z-50">
                            <div className="text-[10px] font-bold text-slate-400 px-3 py-2 uppercase tracking-wider">Export Resolution</div>
                            <button onClick={() => startExportProcess('original')} className="w-full text-left px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 rounded-lg flex items-center justify-between">
                                <span>Original</span> <MonitorPlay size={12} className="text-slate-400"/>
                            </button>
                            <button onClick={() => startExportProcess('4k')} className="w-full text-left px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 rounded-lg flex items-center justify-between">
                                <span>4K Ultra HD</span> <span className="text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">UHD</span>
                            </button>
                            <button onClick={() => startExportProcess('2k')} className="w-full text-left px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 rounded-lg flex items-center justify-between">
                                <span>2K Cinema</span> <span className="text-[10px] bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded">2K</span>
                            </button>
                            <button onClick={() => startExportProcess('1080p')} className="w-full text-left px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 rounded-lg flex items-center justify-between">
                                <span>1080p Full HD</span> <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">FHD</span>
                            </button>
                        </div>
                     )}
                </div>
            </div>

            {/* STAGE */}
            <div 
                className="flex-1 relative flex flex-col items-center justify-center overflow-hidden pb-32 z-10"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
            >
                 <div className="relative w-full max-w-6xl aspect-video shadow-2xl shadow-indigo-900/20 rounded-2xl overflow-hidden bg-slate-900 group">
                    <video
                        ref={videoRef}
                        src={videoSrc || ''}
                        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }}
                        onLoadedMetadata={handleMetadataLoaded}
                        onLoadedData={handleVideoLoaded}
                        onTimeUpdate={handleTimeUpdate}
                        onEnded={() => setMode(ProcessingMode.PAUSED)}
                        playsInline loop muted={isMuted} crossOrigin="anonymous"
                    />
                    
                    <canvas ref={canvasRef} className={`w-full h-full object-contain ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`} />
                    
                    {/* Fixed Export Canvas: Opacity 0 but technically visible for filters */}
                    <canvas ref={exportCanvasRef} className="fixed top-0 left-0 pointer-events-none opacity-0 -z-50" />

                    {/* STATUS BADGES & ZOOM CONTROLS */}
                    <div className="absolute top-6 right-6 flex flex-col gap-3 z-20">
                         {/* Enhanced Badge */}
                         {isEnhanced && !isComparing && (
                            <div className="bg-indigo-600 text-white px-4 py-2 rounded-full text-xs font-bold shadow-lg animate-in fade-in slide-in-from-right-4 flex items-center gap-2 self-end">
                                <Sparkles size={14} className="text-yellow-300" /> ENHANCED
                            </div>
                        )}
                        {/* Compare Badge */}
                         {isComparing && (
                            <div className="bg-slate-700 text-white px-4 py-2 rounded-full text-xs font-bold shadow-lg animate-in fade-in slide-in-from-right-4 flex items-center gap-2 self-end">
                                <Eye size={14} className="text-white" /> ORIGINAL VIEW
                            </div>
                        )}

                        {/* Zoom Controls */}
                        <div className="bg-black/40 backdrop-blur-md rounded-2xl p-2 flex flex-col gap-2 border border-white/10 mt-4 transition-opacity duration-300 opacity-0 group-hover:opacity-100 self-end">
                            <button onClick={handleZoomIn} className="w-10 h-10 flex items-center justify-center text-white hover:bg-white/20 rounded-xl transition-colors active:scale-95" title="Zoom In">
                                <ZoomIn size={20} />
                            </button>
                            <button onClick={handleZoomReset} className="w-10 h-10 flex items-center justify-center text-white hover:bg-white/20 rounded-xl transition-colors active:scale-95" title="Reset Zoom">
                                <RotateCcw size={18} />
                            </button>
                            <button onClick={handleZoomOut} className="w-10 h-10 flex items-center justify-center text-white hover:bg-white/20 rounded-xl transition-colors active:scale-95" title="Zoom Out">
                                <ZoomOut size={20} />
                            </button>
                            {zoom > 1 && (
                                <div className="w-10 h-10 flex items-center justify-center text-indigo-400 animate-pulse">
                                     <Move size={18} />
                                </div>
                            )}
                        </div>
                    </div>
                 </div>
            </div>

            {/* FLOATING CONTROL DECK */}
            <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-40 w-full max-w-3xl px-4">
                <div className="bg-white/80 backdrop-blur-xl border border-white/40 rounded-[2rem] p-4 shadow-2xl shadow-indigo-500/15 flex flex-col gap-4">
                    
                    {/* TOP ROW: TIMELINE */}
                    <div className="flex items-center gap-4 px-2">
                        <span className="text-xs font-mono font-bold text-slate-400 w-12 text-right">{formatTime(currentTime)}</span>
                         <input
                            type="range"
                            min={0}
                            max={duration || 100}
                            value={currentTime}
                            onChange={handleSeek}
                            className="flex-1 h-2 bg-slate-200 rounded-full appearance-none cursor-pointer accent-indigo-600"
                            style={{
                                backgroundSize: `${(currentTime / (duration || 1)) * 100}% 100%`,
                                background: `linear-gradient(to right, #4f46e5 ${(currentTime / (duration || 1)) * 100}%, #e2e8f0 ${(currentTime / (duration || 1)) * 100}%)`
                            }}
                        />
                        <span className="text-xs font-mono font-bold text-slate-400 w-12">{formatTime(duration)}</span>
                    </div>

                    {/* BOTTOM ROW: ACTIONS */}
                    <div className="flex items-center justify-between px-2">
                         <div className="flex items-center gap-2 w-1/3">
                            <button onClick={toggleMute} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-slate-100 text-slate-500 transition-colors">
                                {isMuted ? <VolumeX size={20}/> : <Volume2 size={20}/>}
                            </button>
                         </div>

                         <div className="flex items-center justify-center w-1/3">
                            <button onClick={togglePlay} className="w-14 h-14 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full flex items-center justify-center shadow-lg shadow-indigo-600/30 transition-all active:scale-95">
                                {mode === ProcessingMode.PLAYING ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1"/>}
                            </button>
                         </div>

                         <div className="flex items-center justify-end gap-3 w-1/3">
                            {/* Compare Button - Visible only when Enhanced */}
                            {isEnhanced && (
                                <button
                                    onMouseDown={() => setIsComparing(true)}
                                    onMouseUp={() => setIsComparing(false)}
                                    onMouseLeave={() => setIsComparing(false)}
                                    className="w-10 h-10 flex items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900 transition-colors active:scale-95 border border-slate-200"
                                    title="Hold to Compare Original"
                                >
                                    <SplitSquareHorizontal size={18} />
                                </button>
                            )}
                         
                            <button 
                                onClick={toggleEnhance}
                                className={`flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-sm transition-all shadow-lg active:scale-95 ${isEnhanced ? 'bg-gradient-to-r from-pink-500 to-indigo-500 text-white shadow-indigo-500/30' : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200'}`}
                            >
                                <Wand2 size={16} /> Enhance
                            </button>
                         </div>
                    </div>
                </div>
            </div>
        </>
      )}
    </div>
  );
};

export default App;