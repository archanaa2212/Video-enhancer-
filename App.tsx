import React, { useRef, useEffect, useState } from 'react';
import { FilterState, ProcessingMode, ExportConfig, AnalysisResult } from './types';
import { Upload, Play, Pause, Download, Wand2, Loader2, Undo2, Volume2, VolumeX, MonitorPlay, X, AlertCircle, ScanFace, User, Eraser, Sun, Leaf, FileVideo, CheckCircle2, Smile, Feather, Power, Activity } from 'lucide-react';
import { analyzeFrame } from './services/geminiService';

interface VideoFormat {
  mime: string;
  label: string;
  ext: string;
}

type AppStep = 'upload' | 'original' | 'enhanced';

const App: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const exportCanvasRef = useRef<HTMLCanvasElement>(null);
  
  // OPTIMIZATION: Offscreen canvas for fast blur/retouching calculations
  const tempCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // State Refs for Render Loop
  const filtersRef = useRef<FilterState>({ brightness: 100, contrast: 100, saturation: 100, sharpen: 0, denoise: 40, warmth: 100 });
  const vignetteRef = useRef<number>(0);
  const isUpscaledRef = useRef<boolean>(false);
  const stepRef = useRef<AppStep>('upload');
  
  // Feature Mode Refs
  const isSmoothModeRef = useRef<boolean>(false);
  const isEffectEnabledRef = useRef<boolean>(true);

  // Compare Mode Ref
  const isCompareActiveRef = useRef<boolean>(false);
  
  // Audio Context Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  
  // Rendering Loop Refs
  const animationFrameIdRef = useRef<number | null>(null);
  const videoCallbackIdRef = useRef<number | null>(null);
  
  // Workflow State
  const [step, setStep] = useState<AppStep>('upload');
  
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [originalFileName, setOriginalFileName] = useState<string>('video');
  const [mode, setMode] = useState<ProcessingMode>(ProcessingMode.IDLE);
  
  const [isEnhanced, setIsEnhanced] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isCompareActive, setIsCompareActive] = useState(false);
  
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Feature States
  const [activeFeature, setActiveFeature] = useState<'none' | 'magic'>('none');
  const [isUpscaled, setIsUpscaled] = useState(false); 
  const [isSmoothMode, setIsSmoothMode] = useState(false);
  const [isEffectEnabled, setIsEffectEnabled] = useState(true);
  
  const [lastAnalysis, setLastAnalysis] = useState<AnalysisResult | null>(null);
  const [aiReasoning, setAiReasoning] = useState<string | null>(null);
  
  // Export State
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportConfig, setExportConfig] = useState<ExportConfig>({ 
      filename: '', 
      format: 'mp4',
      resolution: '1080p', 
      fps: 30,
      quality: 'high'
  });
  
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

  const [filters, setFilters] = useState<FilterState>({
    brightness: 100, 
    contrast: 100,   
    saturation: 100, 
    sharpen: 0,     
    denoise: 40, 
    warmth: 100    
  });

  // Init temp canvas for fast blur
  useEffect(() => {
      if (!tempCanvasRef.current) {
          tempCanvasRef.current = document.createElement('canvas');
      }
  }, []);

  // Sync state to ref for render loop immediately
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  useEffect(() => { isUpscaledRef.current = isUpscaled; }, [isUpscaled]);
  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => { isCompareActiveRef.current = isCompareActive; }, [isCompareActive]);
  
  // Sync new toggles
  useEffect(() => { isSmoothModeRef.current = isSmoothMode; }, [isSmoothMode]);
  useEffect(() => { isEffectEnabledRef.current = isEffectEnabled; }, [isEffectEnabled]);

  // Sync vignette from analysis
  useEffect(() => {
     if (lastAnalysis) vignetteRef.current = lastAnalysis.vignette || 0;
     else vignetteRef.current = 0;
  }, [lastAnalysis]);

  // Cleanup
  useEffect(() => {
    return () => {
        if (videoSrc) URL.revokeObjectURL(videoSrc);
        if (videoCallbackIdRef.current && videoRef.current && 'cancelVideoFrameCallback' in videoRef.current) {
            // @ts-ignore
            videoRef.current.cancelVideoFrameCallback(videoCallbackIdRef.current);
        }
        if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
    };
  }, [videoSrc]);

  // Core Rendering Function
  const renderToCanvas = (canvas: HTMLCanvasElement, video: HTMLVideoElement, isExport: boolean, forceW?: number, forceH?: number, overrideFilters?: FilterState) => {
      const ctx = canvas.getContext('2d', { alpha: false }); 
      if (!ctx) return;
      
      const isComparing = isCompareActiveRef.current;
      const isMagic = isEffectEnabledRef.current;
      const isSmooth = isSmoothModeRef.current;
      const isEnhancedStep = stepRef.current === 'enhanced';

      // PROCESSING LOGIC:
      // Apply processing if we are exporting, OR if we are in the enhanced step AND (Magic OR Smooth is ON) AND we are not comparing.
      const shouldApplyProcessing = isExport || (isEnhancedStep && (isMagic || isSmooth) && !isComparing);

      let currentFilters = overrideFilters 
          ? overrideFilters 
          : filtersRef.current;
          
      // IF MAGIC IS OFF: Reset base filters to neutral so "Smooth" applies to the original video.
      // We only use filtersRef.current if Magic is ON.
      if (!isExport && !overrideFilters && !isMagic) {
          currentFilters = { brightness: 100, contrast: 100, saturation: 100, sharpen: 0, denoise: 0, warmth: 100 };
      }

      const isUpscaled = isUpscaledRef.current;
      const vignetteIntensity = isMagic ? vignetteRef.current : 0; // Only show vignette if Magic is ON

      // OVERRIDE FOR SMOOTH MODE
      // If Smooth is ON, we force very high denoise and zero sharpen.
      const effectiveDenoise = isSmooth ? 95 : currentFilters.denoise;
      const effectiveSharpen = isSmooth ? 0 : currentFilters.sharpen;

      let targetWidth = video.videoWidth;
      let targetHeight = video.videoHeight;

      if (forceW && forceH) {
          targetWidth = forceW;
          targetHeight = forceH;
      } else {
          if (isExport) {
             const multiplier = (isUpscaled && isEnhancedStep) ? 2 : 1;
             targetWidth *= multiplier;
             targetHeight *= multiplier;
          } else {
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

      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
          canvas.width = targetWidth;
          canvas.height = targetHeight;
      }

      // SCALING FACTOR: Calculate how much to scale blur radius based on 1080p reference
      const referenceWidth = 1920; 
      const effectsScale = Math.max(1, targetWidth / referenceWidth);
      
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = isExport ? 'high' : 'medium'; 

      if (shouldApplyProcessing) {
          // STEP 1: Base Color Filters (Brightness, Contrast, Saturation)
          ctx.filter = `brightness(${currentFilters.brightness}%) contrast(${currentFilters.contrast}%) saturate(${currentFilters.saturation}%)`;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          
          // STEP 2: Warmth (Correct Color Grading)
          const warmthVal = currentFilters.warmth || 100;
          if (Math.abs(warmthVal - 100) > 5) {
             ctx.filter = 'none';
             if (warmthVal > 100) {
                 const opacity = Math.min((warmthVal - 100) / 300, 0.1); 
                 ctx.fillStyle = `rgba(255, 180, 50, ${opacity})`; 
             } else {
                 const opacity = Math.min((100 - warmthVal) / 300, 0.1); 
                 ctx.fillStyle = `rgba(50, 180, 255, ${opacity})`;
             }
             ctx.globalCompositeOperation = 'source-over'; 
             ctx.fillRect(0, 0, canvas.width, canvas.height);
          }

          // STEP 3: Cosmetic Smoothing (Skin) / Denoise
          // Uses "screen" blend to brighten and smooth simultaneously
          if (effectiveDenoise > 0 && tempCanvasRef.current) {
             let adaptiveDenoise = effectiveDenoise;
             
             const downsampleFactor = isExport ? 2 : 4;
             const tempW = Math.max(128, Math.floor(canvas.width / downsampleFactor)); 
             const tempH = Math.max(128, Math.floor(canvas.height / downsampleFactor));
             
             if (tempCanvasRef.current.width !== tempW || tempCanvasRef.current.height !== tempH) {
                 tempCanvasRef.current.width = tempW;
                 tempCanvasRef.current.height = tempH;
             }
             const tCtx = tempCanvasRef.current.getContext('2d', { alpha: false });
             
             if (tCtx) {
                 tCtx.imageSmoothingEnabled = true;
                 tCtx.imageSmoothingQuality = isExport ? 'high' : 'low'; 
                 
                 tCtx.drawImage(video, 0, 0, tempW, tempH);
                 
                 // If Smooth Mode is active, we use a larger blur radius and higher opacity
                 // to make the effect visually distinct.
                 const intensityMult = isSmooth ? 2.5 : 1.0; 
                 const baseBlurRadius = (isExport ? 6 : 4) * effectsScale;
                 const blurRadius = baseBlurRadius * (0.5 + adaptiveDenoise / 100) * intensityMult;
                 
                 tCtx.filter = `blur(${blurRadius}px)`; 
                 tCtx.drawImage(tempCanvasRef.current, 0, 0, tempW, tempH); 
                 tCtx.filter = 'none';

                 // Significant opacity boost for Smooth Mode
                 const blurOpacity = isSmooth ? 0.75 : (adaptiveDenoise / 100) * 0.45; 
                 
                 ctx.filter = 'none';
                 ctx.globalAlpha = blurOpacity;
                 ctx.globalCompositeOperation = 'screen'; 
                 ctx.drawImage(tempCanvasRef.current, 0, 0, canvas.width, canvas.height);
                 
                 // Blend back normal to regain some texture (less texture in smooth mode)
                 ctx.globalAlpha = blurOpacity * (isSmooth ? 0.2 : 0.5);
                 ctx.globalCompositeOperation = 'source-over';
                 ctx.drawImage(tempCanvasRef.current, 0, 0, canvas.width, canvas.height);
                 
                 ctx.globalAlpha = 1.0;
             }
          }

          // STEP 4: Feature Enhancement (Hair, Ears, Nose, Teeth)
          // "Texture Boost" using Soft Light High-Pass Simulation
          if (effectiveSharpen > 0) {
              ctx.save();
              // High contrast grayscale creates a texture map
              ctx.filter = `grayscale(100%) contrast(150%) brightness(100%)`;
              ctx.globalCompositeOperation = 'soft-light'; 
              
              // Scale opacity based on sharpen value
              ctx.globalAlpha = Math.min((effectiveSharpen / 100) * 0.8, 1.0); 
              
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              ctx.restore();
          }
          
          // STEP 5: Vignette
          if (vignetteIntensity > 0) {
              ctx.filter = 'none';
              const grad = ctx.createRadialGradient(
                  canvas.width / 2, canvas.height / 2, canvas.height * 0.5, 
                  canvas.width / 2, canvas.height / 2, canvas.height * 1.1
              );
              grad.addColorStop(0, "rgba(0,0,0,0)");
              grad.addColorStop(1, `rgba(0,0,0,${Math.min(vignetteIntensity / 100 * 0.5, 0.4)})`);
              
              ctx.globalCompositeOperation = 'source-over';
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          
      } else {
          ctx.filter = 'none';
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      }
      
      ctx.restore();
  };

  const startRenderLoop = () => {
    if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);

    const loop = () => {
      if (videoRef.current && canvasRef.current) {
        renderToCanvas(canvasRef.current, videoRef.current, false);
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
      
      // CHECK FILE SIZE (2GB Limit)
      if (file.size > 2 * 1024 * 1024 * 1024) {
          setErrorMsg("File size exceeds 2GB limit. Please choose a smaller file.");
          event.target.value = '';
          return;
      }

      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
      const fileNameWithoutExt = file.name.split('.').slice(0, -1).join('.');
      setOriginalFileName(fileNameWithoutExt);
      
      // Auto-generate initial filename with version
      const initialExportName = `${fileNameWithoutExt}_enhanced`;
      setExportConfig(prev => ({ ...prev, filename: initialExportName }));
      
      setLoading({ active: true, message: 'Loading Video', progress: 30, subtext: `${file.name} (${fileSizeMB} MB)` });

      const url = URL.createObjectURL(file);
      setVideoSrc(url);
      
      setStep('original');
      setMode(ProcessingMode.IDLE); 
      setActiveFeature('none'); setIsUpscaled(false);
      setIsEnhanced(false);
      setIsMuted(false); 
      setIsCompareActive(false);
      setIsSmoothMode(false);
      setIsEffectEnabled(true);
      setAiReasoning(null);
      setLastAnalysis(null);
      vignetteRef.current = 0;
      setCurrentTime(0); setDuration(0);
      setFilters({ brightness: 100, contrast: 100, saturation: 100, sharpen: 0, denoise: 50, warmth: 100 });
      
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
          // STRICT LIMIT: 1 Minute (60s + 1s buffer)
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
        // Attempt autoplay
        const playPromise = videoRef.current.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                setMode(ProcessingMode.PLAYING);
            }).catch((e) => {
                console.log("Auto-play prevented:", e);
                setMode(ProcessingMode.PAUSED);
            });
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

  const handleStartEnhancement = async () => {
     if (!videoRef.current) return;
     
     setLoading({ active: true, message: 'Scanning Facial Features & Lighting...', progress: 0 });
     const startPlaybackTime = videoRef.current.currentTime;
     videoRef.current.pause();
     setMode(ProcessingMode.ANALYZING);

     try {
        const analysis = await performSmartScan();
        
        setIsEnhanced(true);
        setStep('enhanced');
        setIsEffectEnabled(true); // Ensure enabled by default on new scan
        setLoading(prev => ({ ...prev, progress: 100 }));
        
        if (videoRef.current) {
             videoRef.current.currentTime = startPlaybackTime;
             videoRef.current.play().then(() => setMode(ProcessingMode.PLAYING));
        }

        applyAIEnhance(analysis);

    } catch (e) {
        console.error("Smart Scan Error:", e);
        setIsEnhanced(true);
        setStep('enhanced');
        applyAIEnhance(null);
        if (videoRef.current) videoRef.current.play().then(() => setMode(ProcessingMode.PLAYING));
    } finally {
        setTimeout(() => setLoading(prev => ({ ...prev, active: false })), 500);
    }
  };

  const runFeatureProcess = (name: string, action: () => void) => {
      setLoading({ active: true, message: `Applying ${name}`, progress: 0 });
      let p = 0;
      const interval = setInterval(() => {
          p += 5;
          if (p > 100) p = 100;
          setLoading(prev => ({ ...prev, progress: p }));
          if (p >= 100) {
              clearInterval(interval);
              action();
              setTimeout(() => {
                  setLoading(prev => ({ ...prev, active: false }));
                  if (videoRef.current && videoRef.current.paused) {
                      videoRef.current.play().then(() => setMode(ProcessingMode.PLAYING));
                  }
              }, 250);
          }
      }, 30);
  };
  
  const handleSmoothToggle = () => {
      if (isSmoothMode) {
          setIsSmoothMode(false);
      } else {
          setLoading({ active: true, message: 'Applying Temporal Smoothing...', progress: 0 });
          let p = 0;
          const interval = setInterval(() => {
              p += 10;
              setLoading(prev => ({ ...prev, progress: p }));
              if (p >= 100) {
                  clearInterval(interval);
                  setIsSmoothMode(true);
                  setTimeout(() => {
                      setLoading(prev => ({ ...prev, active: false }));
                  }, 300);
              }
          }, 60);
      }
  };

  const applyAIEnhance = (analysis: AnalysisResult | null = lastAnalysis) => {
      const isActive = activeFeature === 'magic'; 
      if (!isActive) {
          runFeatureProcess('Cosmetic Enhance', () => {
              setActiveFeature('magic');
              setIsUpscaled(true); 
              
              if (analysis) {
                  // BASE ADJUSTMENTS
                  let brightness = analysis.brightness || 100;
                  let contrast = analysis.contrast || 100;
                  let saturation = analysis.saturation || 100;
                  let sharpen = analysis.sharpen || 20;
                  let denoise = analysis.denoise || 20;
                  let warmth = analysis.warmth || 100;

                  // --- 1. LIPS & COLOR POP ---
                  if (analysis.lipsDetected) {
                      saturation = Math.max(saturation, 125); // Boost color for lips
                  }

                  // --- 2. TEETH & CLARITY ---
                  if (analysis.teethDetected) {
                      brightness = Math.max(brightness, 115); // Brighten smile
                      contrast = Math.max(contrast, 110);     // Define edges
                  }

                  // --- 3. HAIR / EARS / NOSE (TEXTURE) ---
                  if (analysis.hairDetected || analysis.faceFeaturesDetected) {
                      // We need sharp details for hair and features
                      sharpen = Math.max(sharpen, 40); 
                      sharpen = Math.min(sharpen, 80); 
                  }

                  // --- 4. SKIN SMOOTHING ---
                  if (analysis.skinDetected) {
                      denoise = Math.max(denoise, 50); 
                      // If we have hair/features, don't over-blur
                      if (analysis.hairDetected) denoise = Math.min(denoise, 70); 
                  }

                  // --- 5. DARK VIDEO FIX ---
                  if (analysis.isLowLight || analysis.brightness < 60) {
                       brightness = Math.max(brightness, 130);
                       contrast = Math.min(contrast, 95);      
                       saturation = Math.min(saturation, 105);
                       sharpen = Math.min(sharpen, 20); // Reduce sharpening in low light
                       vignetteRef.current = 0;
                  }
                  
                  // CLAMPING
                  brightness = Math.min(Math.max(brightness, 90), 160);
                  contrast = Math.min(Math.max(contrast, 80), 130);
                  saturation = Math.min(Math.max(saturation, 0), 150);
                  sharpen = Math.min(Math.max(sharpen, 0), 100);
                  denoise = Math.min(Math.max(denoise, 0), 100);
                  warmth = Math.min(Math.max(warmth, 60), 140);

                  setFilters({ 
                      brightness: Math.round(brightness), 
                      contrast: Math.round(contrast), 
                      saturation: Math.round(saturation), 
                      sharpen: Math.round(sharpen), 
                      denoise: Math.round(denoise),
                      warmth: Math.round(warmth)
                  });
                  
                  if (!analysis.isLowLight) {
                       vignetteRef.current = Math.min(analysis.vignette || 0, 15); 
                  } else {
                       vignetteRef.current = 0;
                  }

              } else {
                   setFilters({ brightness: 110, contrast: 100, saturation: 100, sharpen: 10, denoise: 30, warmth: 100 });
                   vignetteRef.current = 0;
              }
          });
      } else {
          setActiveFeature('none');
          setIsUpscaled(false);
          setFilters({ brightness: 100, contrast: 100, saturation: 100, sharpen: 0, denoise: 40, warmth: 100 });
          vignetteRef.current = 0;
      }
  };

  const performSmartScan = async (): Promise<AnalysisResult | null> => {
     if (!videoRef.current) return null;
     const vid = videoRef.current;
     const dur = vid.duration || 0;
     
     const points = dur > 5 ? [dur * 0.1, dur * 0.5, dur * 0.9] : [dur * 0.5];
     const framesBase64: string[] = [];
     const motionScores: number[] = [];

     const smCanvas = document.createElement('canvas');
     smCanvas.width = 64; smCanvas.height = 64;
     const smCtx = smCanvas.getContext('2d');

     let prevData: Uint8ClampedArray | null = null;

     for (let i = 0; i < points.length; i++) {
         setLoading(prev => ({ ...prev, progress: 10 + (i / points.length) * 40, message: `Scanning Frame ${i+1}/${points.length}` }));
         
         vid.currentTime = points[i];
         
         await new Promise<void>(resolve => {
             const onSeeked = () => { vid.removeEventListener('seeked', onSeeked); resolve(); };
             vid.addEventListener('seeked', onSeeked);
         });

         const tempCanvas = document.createElement('canvas');
         tempCanvas.width = vid.videoWidth; tempCanvas.height = vid.videoHeight;
         const ctx = tempCanvas.getContext('2d');
         ctx?.drawImage(vid, 0, 0);
         framesBase64.push(tempCanvas.toDataURL('image/jpeg', 0.8).split(',')[1]);

         if (smCtx) {
             smCtx.drawImage(vid, 0, 0, 64, 64);
             const currData = smCtx.getImageData(0,0,64,64).data;
             if (prevData) {
                 let diff = 0;
                 for(let k=0; k<currData.length; k+=4) {
                     diff += Math.abs(currData[k] - prevData[k]);
                 }
                 const avgDiff = diff / (64*64);
                 motionScores.push(avgDiff);
             }
             prevData = currData;
         }
     }

     const avgMotion = motionScores.length > 0 ? motionScores.reduce((a,b)=>a+b,0) / motionScores.length : 0;
     const movementLevel = avgMotion > 40 ? 'high' : avgMotion > 15 ? 'moderate' : 'static';

     setLoading(prev => ({ ...prev, message: 'Detecting Facial Features (Lips/Eyes)...', progress: 60 }));

     const framesToAnalyze = framesBase64.slice(0, 2); 
     const aiResults = await Promise.all(framesToAnalyze.map(f => analyzeFrame(f)));

     if (aiResults.length === 0) return null;

     const avg = (key: keyof AnalysisResult) => Math.round(aiResults.reduce((acc, r) => acc + (r[key] as number), 0) / aiResults.length);
     const or = (key: keyof AnalysisResult) => aiResults.some(r => r[key] === true);
     
     const shade = aiResults[0].detectedShade || "Standard";

     const finalResult: AnalysisResult = {
         brightness: avg('brightness'),
         contrast: avg('contrast'),
         saturation: avg('saturation'),
         sharpen: avg('sharpen'),
         denoise: avg('denoise'),
         warmth: avg('warmth'),
         vignette: avg('vignette'),
         detectedShade: shade,
         hairDetected: or('hairDetected'),
         faceFeaturesDetected: or('faceFeaturesDetected'),
         skinDetected: or('skinDetected'),
         lipsDetected: or('lipsDetected'),
         teethDetected: or('teethDetected'),
         natureDetected: or('natureDetected'),
         boostVibrance: or('boostVibrance'),
         isLowLight: or('isLowLight'),
         needsHighlightBoost: or('needsHighlightBoost'),
         animalDetected: or('animalDetected'),
         grainDetected: or('grainDetected'),
         reasoning: aiResults[0].reasoning, 
         movementLevel: movementLevel
     };

     setAiReasoning(finalResult.reasoning);
     setLastAnalysis(finalResult);
     return finalResult;
  };

  // ... (startExportProcess and helper functions remain similar but with renderToCanvas signature update implicit)
  const startExportProcess = async (configOverride?: ExportConfig) => {
    const cfg = configOverride || exportConfig;
    if (!videoRef.current || !exportCanvasRef.current) return;
    const video = videoRef.current;
    if (video.videoWidth === 0) return;

    const frozenFilters = { ...filtersRef.current };
    const originalLoop = video.loop;
    video.loop = false;

    try {
        const ctx = getAudioContext();
        if (ctx.state === 'suspended') await ctx.resume();
    } catch(e) {}

    setMode(ProcessingMode.EXPORTING);
    setLoading({ active: true, message: 'Preparing Export...', progress: 0 });

    const originalCurrentTime = video.currentTime;
    const wasMuted = video.muted;
    video.pause();

    // Export sizing logic same as before...
    const aspect = video.videoWidth / video.videoHeight;
    let targetWidth = video.videoWidth;
    let targetHeight = video.videoHeight;
    const resMap: Record<string, number> = { '480p': 480, '720p': 720, '1080p': 1080 };
    if (cfg.resolution === 'original') {
         if (isUpscaled) { targetWidth *= 2; targetHeight *= 2; }
    } else {
         const targetH = resMap[cfg.resolution] || 1080;
         if (aspect > 1) { targetHeight = targetH; targetWidth = targetH * aspect; } 
         else { targetWidth = targetH; targetHeight = targetH / aspect; }
    }
    targetWidth = Math.round(targetWidth); targetHeight = Math.round(targetHeight);
    if (targetWidth % 2 !== 0) targetWidth -= 1; if (targetHeight % 2 !== 0) targetHeight -= 1;
    const MAX_CANVAS_SIZE = 4096;
    if (targetWidth > MAX_CANVAS_SIZE || targetHeight > MAX_CANVAS_SIZE) {
        const scale = Math.min(MAX_CANVAS_SIZE / targetWidth, MAX_CANVAS_SIZE / targetHeight);
        targetWidth = Math.floor(targetWidth * scale); targetHeight = Math.floor(targetHeight * scale);
        if (targetWidth % 2 !== 0) targetWidth -= 1; if (targetHeight % 2 !== 0) targetHeight -= 1;
    }

    // Bitrate calc...
    const baseBitrates: Record<string, number> = { '1080p': 10_000_000 };
    let bitrate = baseBitrates['1080p'] || 10_000_000;
    if (cfg.resolution !== 'original') { bitrate = baseBitrates[cfg.resolution] || 12_000_000; } 
    else {
        const pixels = targetWidth * targetHeight;
        if (pixels <= 2100000) bitrate = 12_000_000;
        else if (pixels <= 4000000) bitrate = 25_000_000;
        else bitrate = 50_000_000;
    }
    const qualityMult = { 'low': 0.5, 'medium': 1.0, 'high': 1.5, 'ultra': 2.0 };
    bitrate *= qualityMult[cfg.quality] || 1.0;
    if (cfg.fps === 60) bitrate *= 1.2;
    bitrate = Math.min(bitrate, 200_000_000); 

    exportCanvasRef.current.width = targetWidth;
    exportCanvasRef.current.height = targetHeight;
    
    // Audio stream setup...
    let mediaStreamDest: MediaStreamAudioDestinationNode | null = null;
    let audioTracks: MediaStreamTrack[] = [];
    try {
        const ctx = getAudioContext();
        if (audioSourceRef.current) {
            audioSourceRef.current.disconnect(); 
            mediaStreamDest = ctx.createMediaStreamDestination();
            audioSourceRef.current.connect(mediaStreamDest);
            audioTracks = mediaStreamDest.stream.getAudioTracks();
        }
    } catch (e) { console.error("Audio setup failed", e); }

    const stream = exportCanvasRef.current.captureStream(cfg.fps); 
    if (audioTracks.length > 0) stream.addTrack(audioTracks[0]);

    // Recorder setup...
    let mimeType = ''; 
    if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')) mimeType = 'video/mp4;codecs=avc1';
    else if (MediaRecorder.isTypeSupported('video/mp4')) mimeType = 'video/mp4';
    else mimeType = 'video/webm;codecs=vp9';

    let mediaRecorder: MediaRecorder;
    try { mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.floor(bitrate) }); } 
    catch (e) {
        try { mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' }); }
        catch (e2) { alert("Recording not supported."); setLoading({ active: false, message: '', progress: 0 }); return; }
    }
    
    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };

    mediaRecorder.onstop = () => {
      video.loop = originalLoop;
      try { if (audioSourceRef.current && audioCtxRef.current) { audioSourceRef.current.disconnect(); audioSourceRef.current.connect(audioCtxRef.current.destination); } } catch (e) {}
      if (videoCallbackIdRef.current && 'cancelVideoFrameCallback' in video) {
          // @ts-ignore
          video.cancelVideoFrameCallback(videoCallbackIdRef.current);
      }
      video.currentTime = originalCurrentTime; video.muted = wasMuted; video.pause(); setMode(ProcessingMode.PAUSED);

      if (chunks.length === 0) { alert("Export failed"); setLoading(prev => ({ ...prev, active: false })); return; }
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
      const sizeBytes = blob.size;
      const sizeStr = sizeBytes > 1024*1024*1024 ? `${(sizeBytes/(1024*1024*1024)).toFixed(2)} GB` : `${(sizeBytes/(1024*1024)).toFixed(2)} MB`;
      const durationSec = Math.floor(video.duration);
      let ext = 'mp4'; if (mediaRecorder.mimeType.includes('webm')) ext = 'webm';
      const finalFilename = `${cfg.filename}_${cfg.resolution}_${cfg.fps}fps.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = finalFilename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setLoading(prev => ({ ...prev, active: false }));
      setExportSummary({ show: true, filename: finalFilename, size: sizeStr, duration: formatTime(durationSec), resolution: `${targetWidth}x${targetHeight}`, fps: cfg.fps });
      setTimeout(() => { setVideoSrc(null); setStep('upload'); }, 500);
    };

    const drawExportFrame = () => {
        if (mediaRecorder.state !== 'recording') return;
        renderToCanvas(exportCanvasRef.current!, video, true, targetWidth, targetHeight, frozenFilters);
        if (video.duration > 0) setLoading(prev => ({ ...prev, progress: Math.min(99, Math.floor((video.currentTime / video.duration) * 100)) }));
        const isEnded = video.ended || (video.duration > 0 && Math.abs(video.duration - video.currentTime) < 0.2);
        if (isEnded) { setTimeout(() => { if (mediaRecorder.state === 'recording') mediaRecorder.stop(); }, 100); } 
        else { 
            // @ts-ignore
            videoCallbackIdRef.current = video.requestVideoFrameCallback(drawExportFrame); 
        }
    };

    video.currentTime = 0; video.muted = false; setLoading({ active: true, message: 'Exporting...', progress: 0 });
    const startRecording = () => {
        mediaRecorder.start(2000); 
        video.play().then(() => {
             if ('requestVideoFrameCallback' in (video as any)) {
                 // @ts-ignore
                 videoCallbackIdRef.current = video.requestVideoFrameCallback(drawExportFrame);
             } else {
                  const loop = () => {
                      if(mediaRecorder.state !== 'recording') return;
                      renderToCanvas(exportCanvasRef.current!, video, true, targetWidth, targetHeight, frozenFilters);
                      const isEnded = video.ended || (video.duration > 0 && Math.abs(video.duration - video.currentTime) < 0.2);
                      if (isEnded) mediaRecorder.stop(); else requestAnimationFrame(loop);
                  };
                  requestAnimationFrame(loop);
             }
        }).catch(e => { mediaRecorder.stop(); });
    };

    if (Math.abs(video.currentTime) < 0.1) { startRecording(); } 
    else {
        const onSeeked = () => { video.removeEventListener('seeked', onSeeked); setTimeout(startRecording, 200); };
        video.addEventListener('seeked', onSeeked); video.currentTime = 0;
    }
  };

  const confirmExport = () => { setShowExportModal(false); startExportProcess(); };
  const handleQuickExport = () => {
      const quickConfig: ExportConfig = { filename: `${originalFileName}_enhanced`, format: 'mp4', resolution: '1080p', fps: 30, quality: 'high' };
      setExportConfig(quickConfig); startExportProcess(quickConfig);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50 text-slate-900 overflow-hidden font-sans selection:bg-indigo-200 selection:text-indigo-900">
       {/* Error & Modal Components same as before */}
       {errorMsg && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-red-500 text-white px-4 py-2 rounded-full flex items-center gap-2 text-sm shadow-xl animate-in fade-in slide-in-from-top-4">
          <AlertCircle size={16} /> {errorMsg} <button onClick={() => setErrorMsg(null)} className="ml-2 hover:bg-white/20 rounded-full p-0.5"><X size={14} /></button>
        </div>
      )}

      {loading.active && (
        <div className="absolute inset-0 z-50 bg-white/80 backdrop-blur-md flex flex-col items-center justify-center text-slate-800">
          <div className="relative">
            <Loader2 size={48} className="animate-spin text-indigo-600" />
            <div className="absolute inset-0 flex items-center justify-center"> <div className="w-2 h-2 bg-indigo-600 rounded-full animate-pulse"></div> </div>
          </div>
          <p className="mt-4 font-bold text-lg tracking-wide text-indigo-900">{loading.message}</p>
          {loading.subtext && <p className="text-slate-500 text-sm mt-1">{loading.subtext}</p>}
          <div className="w-64 h-1.5 bg-gray-200 rounded-full mt-4 overflow-hidden">
             <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-300 ease-out" style={{ width: `${loading.progress}%` }}></div>
          </div>
        </div>
      )}

      {exportSummary && exportSummary.show && (
         <div className="absolute inset-0 z-50 bg-white/90 backdrop-blur-md flex items-center justify-center p-4">
             <div className="bg-white border border-gray-100 rounded-3xl p-8 max-w-md w-full shadow-2xl shadow-indigo-200/50 relative overflow-hidden">
                 <div className="absolute top-0 inset-x-0 h-2 bg-gradient-to-r from-green-400 to-emerald-500"></div>
                 <div className="flex flex-col items-center text-center">
                     <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4 text-green-600 ring-4 ring-green-50"> <CheckCircle2 size={32} /> </div>
                     <h3 className="text-2xl font-bold text-slate-900 mb-2">Export Complete!</h3>
                     <p className="text-slate-500 text-sm mb-6">Your video has been enhanced and saved.</p>
                     <div className="w-full bg-slate-50 rounded-xl p-4 mb-6 space-y-3 border border-slate-100">
                         <div className="flex justify-between text-sm"> <span className="text-slate-500">Filename</span> <span className="text-slate-900 font-mono text-xs truncate max-w-[180px]">{exportSummary.filename}</span> </div>
                         <div className="flex justify-between text-sm"> <span className="text-slate-500">Size</span> <span className="text-slate-900 font-mono text-xs">{exportSummary.size}</span> </div>
                         <div className="flex justify-between text-sm"> <span className="text-slate-500">Duration</span> <span className="text-slate-900 font-mono text-xs">{exportSummary.duration}</span> </div>
                         <div className="flex justify-between text-sm"> <span className="text-slate-500">Resolution</span> <span className="text-slate-900 font-mono text-xs">{exportSummary.resolution}</span> </div>
                     </div>
                     <button onClick={() => setExportSummary(null)} className="w-full py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/20"> Process Another Video </button>
                 </div>
             </div>
         </div>
      )}

      {step === 'upload' ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-500 bg-gradient-to-b from-indigo-50/50 to-white">
             <div 
                className="w-full max-w-2xl aspect-[21/9] border-2 border-dashed border-indigo-200 rounded-3xl bg-white flex flex-col items-center justify-center cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/30 transition-all group relative overflow-hidden shadow-sm hover:shadow-md"
                onClick={() => fileInputRef.current?.click()}
             >
                <div className="p-5 bg-indigo-50 rounded-full mb-4 group-hover:scale-110 transition-transform duration-300 relative z-10 text-indigo-500">
                    <Upload size={32} />
                </div>
                <h3 className="text-xl font-bold text-slate-800 mb-2 relative z-10">Select a video to enhance</h3>
                <p className="text-slate-500 text-sm max-w-xs relative z-10">Supports MP4, WebM, MOV. Up to 2GB.</p>
                <input ref={fileInputRef} type="file" accept="video/mp4,video/webm,video/quicktime" className="hidden" onChange={handleFileChange} />
             </div>
        </div>
      ) : (
        <>
            <div className="flex-none px-4 md:px-6 py-3 border-b border-gray-200 flex items-center justify-between bg-white/80 backdrop-blur-sm z-30">
                <div className="flex items-center gap-4">
                     {step === 'enhanced' && (
                         <button onClick={() => { setStep('original'); setActiveFeature('none'); setIsEnhanced(false); }} className="text-slate-500 hover:text-slate-800 flex items-center gap-2 text-xs font-bold px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-all"> <Undo2 size={14}/> Revert </button>
                     )}
                     <div className="h-4 w-px bg-gray-200 mx-2"></div>
                     <h3 className="text-sm font-semibold text-slate-700 truncate max-w-[200px]">{originalFileName}</h3>
                </div>
                <div className="flex items-center gap-2">
                     <button onClick={() => handleQuickExport()} className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/20"> <Download size={14} /> Download HD </button>
                </div>
            </div>

            <div className="flex-1 relative bg-gray-100/50 flex flex-col items-center justify-center overflow-hidden">
                 <div className="relative w-full h-full flex items-center justify-center max-h-[calc(100vh-160px)] p-4">
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
                    
                    <canvas ref={canvasRef} className="max-w-full max-h-full object-contain shadow-2xl rounded-lg bg-black" />
                    
                    <canvas ref={exportCanvasRef} className="hidden" />

                    {step === 'enhanced' && !isEffectEnabled && !isSmoothMode && (
                        <div className="absolute top-8 right-8 z-10">
                            <div className="bg-white/90 backdrop-blur-md border border-gray-200 text-slate-800 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider flex items-center gap-2 animate-in fade-in shadow-lg">
                                <Power size={14} className="text-red-500"/> Original
                            </div>
                        </div>
                    )}
                    
                    {step === 'enhanced' && (isEffectEnabled || isSmoothMode) && (
                        <div className="absolute top-8 right-8 flex flex-col gap-2 z-10">
                            <button
                                onMouseDown={() => setIsCompareActive(true)}
                                onMouseUp={() => setIsCompareActive(false)}
                                onMouseLeave={() => setIsCompareActive(false)}
                                onTouchStart={() => setIsCompareActive(true)}
                                onTouchEnd={() => setIsCompareActive(false)}
                                className="bg-white/90 backdrop-blur-md border border-gray-200 text-slate-800 px-4 py-2 rounded-full text-xs font-bold uppercase tracking-wider hover:bg-white transition-all select-none active:scale-95 flex items-center gap-2 shadow-lg"
                            >
                                <ScanFace size={14} className="text-indigo-500"/> Hold to Compare
                            </button>
                            {isCompareActive && (
                                <div className="absolute top-12 right-0 bg-indigo-600 text-white text-[10px] font-bold px-2 py-1 rounded shadow-lg animate-in fade-in zoom-in"> SHOWING ORIGINAL </div>
                            )}
                        </div>
                    )}
                 </div>
            </div>

            {/* CONTROLS BELOW VIDEO - LIGHT THEME */}
            <div className="flex-none bg-white border-t border-gray-200 p-4 flex flex-col gap-3 z-20 shadow-lg shadow-gray-200/50">
                <div className="flex items-center gap-4 w-full max-w-4xl mx-auto">
                    <button onClick={togglePlay} className="w-10 h-10 flex-none flex items-center justify-center text-white hover:bg-indigo-700 transition-colors bg-indigo-600 rounded-full shadow-md shadow-indigo-600/20">
                        {mode === ProcessingMode.PLAYING ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                    </button>
                    
                    <div className="flex-1 flex flex-col justify-center">
                         <input
                            type="range"
                            min={0}
                            max={duration || 100}
                            value={currentTime}
                            onChange={handleSeek}
                            className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600 hover:h-2 transition-all"
                            style={{
                                backgroundSize: `${(currentTime / (duration || 1)) * 100}% 100%`,
                                background: `linear-gradient(to right, #4f46e5 ${(currentTime / (duration || 1)) * 100}%, #e5e7eb ${(currentTime / (duration || 1)) * 100}%)`
                            }}
                        />
                    </div>
                    
                    <div className="text-xs font-mono font-bold text-slate-500 select-none w-24 text-right">
                        <span>{formatTime(currentTime)}</span> / <span>{formatTime(duration)}</span>
                    </div>

                    <button onClick={toggleMute} className="text-slate-400 hover:text-indigo-600 transition-colors p-2 hover:bg-indigo-50 rounded-full">
                        {isMuted ? <VolumeX size={18}/> : <Volume2 size={18}/>}
                    </button>
                    
                    {/* ENHANCEMENT CONTROLS */}
                    {step === 'enhanced' && (
                        <div className="flex items-center gap-3 pl-6 border-l border-gray-200 ml-2">
                             <button 
                                onClick={handleSmoothToggle}
                                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all border ${isSmoothMode ? 'bg-cyan-50 border-cyan-200 text-cyan-700 shadow-sm' : 'bg-white border-gray-200 text-slate-500 hover:text-slate-800 hover:border-gray-300'}`}
                                title="Reduce roughness and noise"
                            >
                                <Feather size={14} className={isSmoothMode ? "text-cyan-600" : ""} /> 
                                <span>Smooth</span>
                            </button>
                            
                             <button 
                                onClick={() => setIsEffectEnabled(!isEffectEnabled)}
                                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all border ${isEffectEnabled ? 'bg-indigo-50 border-indigo-200 text-indigo-700 shadow-sm' : 'bg-white border-gray-200 text-slate-500 hover:text-slate-800 hover:border-gray-300'}`}
                                title="Toggle Enhancement"
                            >
                                <Power size={14} className={isEffectEnabled ? "text-indigo-600" : ""} /> 
                                <span>Magic Enhance</span>
                            </button>
                        </div>
                    )}

                    {step === 'original' && (
                         <button
                            onClick={handleStartEnhancement}
                            className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-xs font-bold uppercase tracking-wider rounded-xl shadow-lg shadow-indigo-600/20 transition-all transform hover:scale-105 ml-2"
                         >
                            <Wand2 size={14} className="animate-pulse" />
                            <span>Magic Enhance</span>
                         </button>
                    )}
                </div>
            </div>
        </>
      )}
    </div>
  );
};

export default App;