import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ProcessingMode } from './types';
import { Upload, Play, Pause, Download, Loader2, Undo2, Volume2, VolumeX, AlertCircle, X, CheckCircle2, ZoomIn, ZoomOut, RotateCcw, Wand2, Sparkles, ChevronDown, SplitSquareHorizontal, Eye, Share2, FileVideo } from 'lucide-react';

// --- GLSL SHADERS ---
const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
varying vec2 v_rawCoord;

void main() {
   gl_Position = vec4(a_position, 0.0, 1.0);
   v_texCoord = a_texCoord;
   v_rawCoord = a_texCoord;
}
`;

const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
uniform sampler2D u_image;
uniform vec2 u_resolution;
uniform float u_zoom;
uniform vec2 u_pan;
uniform bool u_is_enhanced;
uniform bool u_is_split;
uniform float u_slider_pos;
uniform float u_smooth_strength;

varying vec2 v_texCoord;
varying vec2 v_rawCoord;

// --- Skin Detection (YCbCr) ---
bool isSkin(vec3 rgb) {
    float r = rgb.r;
    float g = rgb.r;
    float b = rgb.b;
    float Y  =  0.299*r + 0.587*g + 0.114*b;
    float Cb = -0.169*r - 0.331*g + 0.500*b + 0.5;
    float Cr =  0.500*r - 0.419*g - 0.081*b + 0.5;
    return (Cb > 0.3 && Cb < 0.7 && Cr > 0.3 && Cr < 0.7 && Y > 0.2);
}

// --- Bilateral Blur (Edge-Preserving) ---
vec3 bilateralBlur(sampler2D tex, vec2 uv, vec2 texel) {
    vec3 center = texture2D(tex, uv).rgb;
    vec3 sum = vec3(0.0);
    float total = 0.0;
    // 5x5 Kernel
    for (int x = -2; x <= 2; x++) {
        for (int y = -2; y <= 2; y++) {
            vec2 offset = vec2(float(x), float(y)) * texel;
            vec3 sample = texture2D(tex, uv + offset).rgb;
            float diff = length(sample - center);
            float weight = exp(-(diff * 12.0)); 
            sum += sample * weight;
            total += weight;
        }
    }
    return sum / total;
}

// --- Sharpen ---
vec3 sharpen(sampler2D tex, vec2 uv, vec2 texel) {
    vec3 center = texture2D(tex, uv).rgb;
    vec3 up = texture2D(tex, uv + vec2(0.0, -texel.y)).rgb;
    vec3 down = texture2D(tex, uv + vec2(0.0, texel.y)).rgb;
    vec3 left = texture2D(tex, uv + vec2(-texel.x, 0.0)).rgb;
    vec3 right = texture2D(tex, uv + vec2(texel.x, 0.0)).rgb;
    return center * 1.4 - (up + down + left + right) * 0.1; 
}

void main() {
    vec2 center = vec2(0.5);
    vec2 uv = (v_texCoord - center) / u_zoom + center - u_pan;

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec3 color = texture2D(u_image, uv).rgb;
    vec3 original = color;

    if (u_is_split && v_rawCoord.x > u_slider_pos) {
        // We draw the line in CSS overlay now for better UI, 
        // but keep a tiny gap or just render original here.
        gl_FragColor = vec4(original, 1.0);
        return;
    }

    if (u_is_enhanced) {
        vec2 texel = 1.0 / u_resolution;
        bool skin = isSkin(color);

        if (skin) {
            vec3 smoothed = bilateralBlur(u_image, uv, texel);
            color = mix(color, smoothed, u_smooth_strength);
        } else {
            vec3 sharp = sharpen(u_image, uv, texel);
            color = mix(color, sharp, 0.3);
        }

        // Color Grading
        color *= 1.03; // Exposure
        color = (color - 0.5) * 1.05 + 0.5; // Contrast
        float gray = dot(color, vec3(0.299, 0.587, 0.114));
        color = mix(vec3(gray), color, 1.12); // Saturation
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

type AppStep = 'upload' | 'original' | 'enhanced';
type ResolutionOption = 'original' | '1080p'; // Removed '2k' and '4k'

interface GLContext {
    gl: WebGLRenderingContext;
    program: WebGLProgram;
    positionBuffer: WebGLBuffer;
    texCoordBuffer: WebGLBuffer;
    texture: WebGLTexture;
}

const App: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  // Canvas Refs
  const canvasRef = useRef<HTMLCanvasElement>(null); 
  const exportCanvasRef = useRef<HTMLCanvasElement>(null); // Reintroduced
  
  // WebGL Context Refs
  const mainGLRef = useRef<GLContext | null>(null);
  const exportGLRef = useRef<GLContext | null>(null); // Reintroduced

  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // State Refs for Render Loop
  const isEnhancedRef = useRef<boolean>(false);
  const isComparingRef = useRef<boolean>(false); 
  const isSplitViewRef = useRef<boolean>(false); 
  const sliderPosRef = useRef<number>(0.5); 
  const isExportingRef = useRef<boolean>(false); // Still used for loading overlay
  const animationFrameLoopIdRef = useRef<number | null>(null); // For export loop

  // Zoom & Pan Refs
  const zoomRef = useRef<number>(1);
  const panRef = useRef<{x: number, y: number}>({ x: 0, y: 0 });
  
  // Interaction Refs
  const isDraggingRef = useRef<boolean>(false);
  const isDraggingSliderRef = useRef<boolean>(false);
  const lastMousePosRef = useRef<{x: number, y: number}>({ x: 0, y: 0 });
  
  // Audio
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  
  // State
  const [step, setStep] = useState<AppStep>('upload');
  const [isEnhanced, setIsEnhanced] = useState(false);
  const [isComparing, setIsComparing] = useState(false); 
  const [isSplitView, setIsSplitView] = useState(false); 
  
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [originalFile, setOriginalFile] = useState<File | null>(null); // Store the original file
  const [originalFileName, setOriginalFileName] = useState<string>('video');
  const [fileSizeStr, setFileSizeStr] = useState<string>('');
  
  const [mode, setMode] = useState<ProcessingMode>(ProcessingMode.IDLE);
  const [isMuted, setIsMuted] = useState(false);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<{x: number, y: number}>({ x: 0, y: 0 });
  const [sliderPos, setSliderPosState] = useState(0.5); // For React rendering of handle
  
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  
  // Save Dialog State
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [exportName, setExportName] = useState('');
  const [selectedResolution, setSelectedResolution] = useState<ResolutionOption>('original'); // Resolution for export
  
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

  // No longer using FFmpeg.wasm, so no SharedArrayBuffer check needed for it
  // const [isEnvironmentCompatibleForFFmpeg, setIsEnvironmentCompatibleForFFmpeg] = useState(true);

  // Sync state to refs
  useEffect(() => { isEnhancedRef.current = isEnhanced; }, [isEnhanced]);
  useEffect(() => { isComparingRef.current = isComparing; }, [isComparing]);
  useEffect(() => { isSplitViewRef.current = isSplitView; }, [isSplitView]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // --- WEBGL HELPERS ---
  const initWebGL = (canvas: HTMLCanvasElement): GLContext | null => {
      const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
      if (!gl) return null;

      const createShader = (type: number, source: string) => {
          const shader = gl.createShader(type);
          if (!shader) return null;
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
              console.error(gl.getShaderInfoLog(shader));
              gl.deleteShader(shader);
              return null;
          }
          return shader;
      };

      const vs = createShader(gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
      const fs = createShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
      if (!vs || !fs) return null;

      const program = gl.createProgram();
      if (!program) return null;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0]), gl.STATIC_DRAW);

      const texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0]), gl.STATIC_DRAW);

      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      return { gl, program, positionBuffer: positionBuffer!, texCoordBuffer: texCoordBuffer!, texture: texture! };
  };

  const renderGLFrame = (ctx: GLContext, source: TexImageSource, width: number, height: number, isExport: boolean) => {
      const { gl, program, positionBuffer, texCoordBuffer, texture } = ctx;

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);

      const positionLoc = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(positionLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

      const texCoordLoc = gl.getAttribLocation(program, 'a_texCoord');
      gl.enableVertexAttribArray(texCoordLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), width, height);

      const z = isExport ? 1.0 : zoomRef.current;
      const p = isExport ? {x:0, y:0} : panRef.current;
      gl.uniform1f(gl.getUniformLocation(program, 'u_zoom'), z);
      gl.uniform2f(gl.getUniformLocation(program, 'u_pan'), p.x, p.y);

      // isExport determines if we are rendering for the final export (no comparison)
      // Otherwise, enhancement state is controlled by isEnhancedRef
      const enhanceActive = (isExport && isEnhancedRef.current) || (isEnhancedRef.current && !isComparingRef.current);
      gl.uniform1i(gl.getUniformLocation(program, 'u_is_enhanced'), enhanceActive ? 1 : 0);

      const splitActive = !isExport && isSplitViewRef.current && isEnhancedRef.current;
      gl.uniform1i(gl.getUniformLocation(program, 'u_is_split'), splitActive ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(program, 'u_slider_pos'), sliderPosRef.current);
      gl.uniform1f(gl.getUniformLocation(program, 'u_smooth_strength'), 0.35);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const startRenderLoop = useCallback(() => {
    if (animationFrameIdRef.current) cancelAnimationFrame(animationFrameIdRef.current);
    const loop = () => {
      if (videoRef.current && videoRef.current.readyState >= 2 && canvasRef.current) {
         if (!mainGLRef.current) mainGLRef.current = initWebGL(canvasRef.current);
         if (mainGLRef.current) renderGLFrame(mainGLRef.current, videoRef.current, canvasRef.current.width, canvasRef.current.height, false);
      }
      animationFrameIdRef.current = requestAnimationFrame(loop);
    };
    loop();
  }, []);

  // --- EVENT HANDLERS ---
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setErrorMsg(null); setExportSummary(null);
    if (file) {
      if (videoSrc) URL.revokeObjectURL(videoSrc);
      const name = file.name.split('.').slice(0, -1).join('.');
      setOriginalFileName(name);
      setExportName(name + '_enhanced'); // Default export name
      setFileSizeStr(formatFileSize(file.size));
      setOriginalFile(file); // Store the original file object
      
      setLoading({ active: true, message: 'Loading Video', progress: 30, subtext: 'Preparing workspace...' });
      const url = URL.createObjectURL(file);
      setVideoSrc(url);
      setStep('original');
      setMode(ProcessingMode.IDLE); 
      setZoom(1); setPan({x: 0, y: 0}); 
      setIsMuted(false); setIsEnhanced(false); setIsSplitView(false);
      setCurrentTime(0); setDuration(0);
      mainGLRef.current = null; exportGLRef.current = null; // Reintroduced
      setTimeout(() => setLoading(prev => ({...prev, active: false})), 1000);
    }
    event.target.value = '';
  };

  const handleMetadataLoaded = () => {
      if (videoRef.current && canvasRef.current) {
          canvasRef.current.width = videoRef.current.videoWidth;
          canvasRef.current.height = videoRef.current.videoHeight;
          setDuration(videoRef.current.duration);
      }
  };

  const handleVideoLoaded = () => {
     startRenderLoop();
     try {
        if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
        if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
        if (!audioSourceRef.current && videoRef.current) {
            audioSourceRef.current = audioCtxRef.current.createMediaElementSource(videoRef.current);
            audioSourceRef.current.connect(audioCtxRef.current.destination);
        }
     } catch (e) { console.error("Audio Context Error", e); }
     videoRef.current?.play().then(() => setMode(ProcessingMode.PLAYING)).catch(() => setMode(ProcessingMode.PAUSED));
  };

  const togglePlay = (e?: React.MouseEvent) => { e?.stopPropagation(); videoRef.current?.paused ? videoRef.current.play().then(()=>setMode(ProcessingMode.PLAYING)) : (videoRef.current?.pause(), setMode(ProcessingMode.PAUSED)); };
  const toggleMute = (e?: React.MouseEvent) => { e?.stopPropagation(); if(videoRef.current) { videoRef.current.muted = !videoRef.current.muted; setIsMuted(videoRef.current.muted); }};
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => { if(videoRef.current) { videoRef.current.currentTime = Number(e.target.value); setCurrentTime(videoRef.current.currentTime); }};
  const handleTimeUpdate = () => videoRef.current && setCurrentTime(videoRef.current.currentTime);
  const toggleEnhance = () => { setIsEnhanced(p => !p); if(isEnhanced) setIsSplitView(false); };
  
  const toggleSplitView = () => { 
      if(!isEnhanced) setIsEnhanced(true); 
      setIsSplitView(p => !p); 
      setSliderPos(0.5); 
  };
  
  const setSliderPos = (pos: number) => {
      const p = Math.max(0, Math.min(1, pos));
      sliderPosRef.current = p;
      setSliderPosState(p); // Update state for UI handle
  };

  const getVideoNormalizedPos = (e: React.MouseEvent | React.TouchEvent) => {
     if(!canvasRef.current) return 0.5;
     const rect = canvasRef.current.getBoundingClientRect();
     const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
     const x = clientX - rect.left;
     return Math.max(0, Math.min(1, x / rect.width)); 
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    if (isSplitViewRef.current) {
        const pos = getVideoNormalizedPos(e);
        // Larger hit area for slider logic
        if (Math.abs(pos - sliderPosRef.current) < 0.15) {
             isDraggingSliderRef.current = true; 
             setSliderPos(pos);
        } else if (zoomRef.current > 1) {
             isDraggingRef.current = true; // Pan
        }
    } else if (zoomRef.current > 1) {
        isDraggingRef.current = true;
    }
    lastMousePosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    e.preventDefault();
    if (isDraggingSliderRef.current && isSplitViewRef.current) {
        setSliderPos(getVideoNormalizedPos(e));
    } else if (isDraggingRef.current) {
        const dx = e.clientX - lastMousePosRef.current.x;
        const dy = e.clientY - lastMousePosRef.current.y;
        const z = zoomRef.current;
        setPan({ x: panRef.current.x + (dx/500/z), y: panRef.current.y + (dy/500/z) }); 
    }
    if (isDraggingRef.current) {
       lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!canvasRef.current) return;
    const { clientX, clientY } = e.touches[0];
    if (isSplitViewRef.current) {
        const pos = getVideoNormalizedPos(e);
        if (Math.abs(pos - sliderPosRef.current) < 0.15) {
             isDraggingSliderRef.current = true; 
             setSliderPos(pos);
        } else if (zoomRef.current > 1) {
             isDraggingRef.current = true; 
        }
    } else if (zoomRef.current > 1) {
        isDraggingRef.current = true;
    }
    lastMousePosRef.current = { x: clientX, y: clientY };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isDraggingSliderRef.current && isSplitViewRef.current) {
        setSliderPos(getVideoNormalizedPos(e));
    } else if (isDraggingRef.current) {
        const { clientX, clientY } = e.touches[0];
        const dx = clientX - lastMousePosRef.current.x;
        const dy = clientY - lastMousePosRef.current.y;
        const z = zoomRef.current;
        setPan({ x: panRef.current.x + (dx/500/z), y: panRef.current.y + (dy/500/z) }); 
        lastMousePosRef.current = { x: clientX, y: clientY };
    }
  };

  const handleTouchEnd = () => { isDraggingRef.current = false; isDraggingSliderRef.current = false; };
  const handleMouseUp = () => { isDraggingRef.current = false; isDraggingSliderRef.current = false; };

  // --- EXPORT LOGIC ---
  const initiateExport = (res: ResolutionOption) => {
      setSelectedResolution(res);
      setShowExportMenu(false);
      setShowSaveDialog(true);
  };

  const executeExport = async () => {
    if (!videoRef.current || !exportCanvasRef.current) return;
    const video = videoRef.current;
    setShowSaveDialog(false);
    setMode(ProcessingMode.EXPORTING);
    isExportingRef.current = true;
    setLoading({ active: true, message: 'Starting video capture...', progress: 10, subtext: 'Rendering frames in real-time.' });
    setErrorMsg(null); // Clear any previous error messages

    // Determine target resolution for export
    let tW = 1920, tH = 1080; // Default to 1080p
    const res = selectedResolution;

    if (res === '1080p') { 
        tW = 1920; tH = 1080; 
    } else if (res === 'original') { 
        // Use original dimensions, but ensure minimum 1080p
        tW = video.videoWidth; 
        tH = video.videoHeight;
        
        if (tH < 1080) { // If original height is less than 1080p, upscale to 1080p
            const aspectRatio = tW / tH;
            tH = 1080;
            tW = Math.round(tH * aspectRatio);
        }
    }
    
    // Ensure even dimensions for compatibility
    if (tW % 2 !== 0) tW--; 
    if (tH % 2 !== 0) tH--; 

    exportCanvasRef.current.width = tW;
    exportCanvasRef.current.height = tH;

    if (!exportGLRef.current) exportGLRef.current = initWebGL(exportCanvasRef.current);
    if (!exportGLRef.current) {
        setErrorMsg("Failed to initialize WebGL for export canvas.");
        setLoading({active:false, message:'', progress:0});
        setMode(ProcessingMode.PAUSED);
        isExportingRef.current = false;
        return;
    }

    video.currentTime = 0;
    await new Promise(r => setTimeout(r, 200)); // Give video a moment to seek

    // Get video stream from canvas and audio stream from video element
    const canvasStream = exportCanvasRef.current.captureStream(30); // 30 FPS capture
    const audioTrack = video.captureStream().getAudioTracks()[0]; // Get audio track from original video
    
    const combinedStream = new MediaStream();
    if (canvasStream.getVideoTracks().length > 0) {
        combinedStream.addTrack(canvasStream.getVideoTracks()[0]);
    }
    if (audioTrack) {
        combinedStream.addTrack(audioTrack);
    } else {
        console.warn("No audio track found for export.");
    }

    // Attempt to use MP4 if supported, fallback to WebM
    let mimeType = 'video/webm;codecs=vp9';
    if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')) {
        mimeType = 'video/mp4;codecs=avc1';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) {
        mimeType = 'video/webm;codecs=vp8';
    } else {
        setErrorMsg("Your browser does not support WebM or MP4 video recording. Export may not work.");
    }

    const recorder = new MediaRecorder(combinedStream, { 
        mimeType: mimeType, 
        videoBitsPerSecond: 10000000 // 10 Mbps for reasonable quality
    });
    
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    
    const stopPromise = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    recorder.start();
    
    try { await video.play(); } catch(e) {} // Play video to ensure frames are drawn

    const exportLoop = () => {
        if (!isExportingRef.current) {
            if (animationFrameLoopIdRef.current) cancelAnimationFrame(animationFrameLoopIdRef.current);
            recorder.stop(); // Ensure recorder is stopped on cancel
            return;
        }
        if (video.ended) { 
            recorder.stop(); 
            if (animationFrameLoopIdRef.current) cancelAnimationFrame(animationFrameLoopIdRef.current);
            return; 
        }
        // Render current video frame with enhancements to the off-screen export canvas
        if (exportGLRef.current) renderGLFrame(exportGLRef.current, video, tW, tH, true);
        const p = (video.currentTime / video.duration) * 100;
        setLoading(prev => ({ ...prev, progress: Math.min(100, p), subtext: `Recording video frames: ${Math.round(p)}% complete` })); // Progress directly to 100%
        animationFrameLoopIdRef.current = requestAnimationFrame(exportLoop);
    };
    animationFrameLoopIdRef.current = requestAnimationFrame(exportLoop); // Start the export rendering loop

    await stopPromise; // Wait for recording to finish
    video.pause();

    if (!isExportingRef.current) { // Export cancelled
        setLoading({active:false, message:'', progress:0});
        setMode(ProcessingMode.PAUSED);
        return;
    }

    // MediaRecorder output is the final output
    let finalBlob = new Blob(chunks, { type: mimeType });
    let finalDlName = exportName.trim() || 'enhanced_video';
    let outputFormat = mimeType.includes('mp4') ? 'mp4' : 'webm';

    if(!finalDlName.toLowerCase().endsWith(`.${outputFormat}`)) finalDlName += `.${outputFormat}`;
    triggerDownload(finalBlob, finalDlName, outputFormat);

    setLoading({ active: true, message: 'Finalizing video file...', progress: 95, subtext: 'Preparing for download.' });
    setTimeout(() => {
        setExportSummary({ show: true, filename: finalDlName, size: formatFileSize(finalBlob.size), duration: formatTime(duration), resolution: `${tW}x${tH}`, fps: 30 });
        setLoading({active:false, message:'', progress:0}); 
        setMode(ProcessingMode.PAUSED); 
        isExportingRef.current = false;
    }, 1000);
  };

  const triggerDownload = (blob: Blob, filename: string, type: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); // Required for Firefox
    a.click();
    document.body.removeChild(a); // Clean up
    URL.revokeObjectURL(url);
  };

  const formatTime = (seconds: number) => {
      if (isNaN(seconds)) return "00:00";
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handleZoomIn = (e: React.MouseEvent) => { e.stopPropagation(); setZoom(z => Math.min(z + 0.5, 4)); };
  const handleZoomOut = (e: React.MouseEvent) => { e.stopPropagation(); setZoom(z => { const n = Math.max(z - 0.5, 1); if(n===1) setPan({x:0,y:0}); return n; }); };
  const handleZoomReset = (e: React.MouseEvent) => { e.stopPropagation(); setZoom(1); setPan({x:0,y:0}); };

  return (
    <div className="flex flex-col h-screen bg-slate-50 text-slate-800 font-sans overflow-hidden selection:bg-indigo-100 selection:text-indigo-900">
      
      {/* BACKGROUND */}
      <div className="fixed inset-0 z-0 pointer-events-none opacity-60">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-purple-200/40 rounded-full blur-[120px] animate-pulse"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-blue-200/40 rounded-full blur-[120px] animate-pulse" style={{animationDelay: '2s'}}></div>
      </div>
       
       {/* ERROR TOAST */}
       {errorMsg && (
        <div className="fixed top-6 left-4 right-4 md:left-1/2 md:-translate-x-1/2 z-50 bg-white/95 backdrop-blur-md border border-red-100 text-red-600 px-4 py-3 rounded-2xl flex items-start gap-3 text-sm shadow-xl animate-in fade-in slide-in-from-top-4">
          <AlertCircle size={18} className="mt-0.5 shrink-0" /> 
          <span className="font-medium flex-1">{errorMsg}</span> 
          <button onClick={() => setErrorMsg(null)} className="hover:bg-red-50 rounded-full p-1"><X size={14} /></button>
        </div>
      )}

      {/* LOADING OVERLAY */}
      {loading.active && (
        <div className="absolute inset-0 z-50 bg-white/80 backdrop-blur-md flex flex-col items-center justify-center p-4 text-center">
          <Loader2 size={48} className="animate-spin text-indigo-600 mb-6" strokeWidth={1.5} />
          <p className="font-bold text-xl text-slate-900 mb-2">{loading.message}</p>
          <p className="text-slate-500 text-sm font-medium">{loading.subtext}</p>
          <div className="w-64 h-1.5 bg-slate-200 rounded-full mt-6 overflow-hidden">
             <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${loading.progress}%` }}></div>
          </div>
        </div>
      )}

      {/* SAVE AS DIALOG */}
      {showSaveDialog && (
          <div className="absolute inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-white rounded-[2rem] p-6 w-full max-w-sm shadow-2xl animate-in zoom-in-95">
                  <h3 className="text-xl font-bold text-slate-900 mb-4">Export Settings</h3>
                  
                  <label className="block text-sm font-bold text-slate-500 mb-2">Filename</label>
                  <input 
                    type="text" 
                    value={exportName} 
                    onChange={(e) => setExportName(e.target.value)} 
                    className="w-full bg-slate-100 border-none rounded-xl px-4 py-3 text-slate-900 font-medium focus:ring-2 focus:ring-indigo-500 outline-none mb-4"
                    placeholder="Enter filename"
                  />

                  <div className="bg-slate-50 rounded-xl p-3 mb-6">
                      <div className="flex justify-between text-sm mb-1">
                          <span className="text-slate-500">Quality</span>
                          {isEnhanced ? (
                              <span className="font-bold text-indigo-600">Enhanced (Browser Native)</span>
                          ) : (
                              <span className="font-bold text-slate-600">Original (Browser Native)</span>
                          )}
                      </div>
                      <div className="flex justify-between text-sm">
                          <span className="text-slate-500">Resolution</span>
                          <span className="font-bold text-slate-800 uppercase">{selectedResolution}</span>
                      </div>
                  </div>

                  <div className="flex gap-3">
                      <button onClick={() => setShowSaveDialog(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-xl hover:bg-slate-200 transition-colors">Cancel</button>
                      <button onClick={executeExport} className="flex-1 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-600/20">Save Video</button>
                  </div>
              </div>
          </div>
      )}

      {/* EXPORT SUCCESS MODAL */}
      {exportSummary && exportSummary.show && (
         <div className="absolute inset-0 z-50 bg-white/90 backdrop-blur-xl flex items-center justify-center p-4">
             <div className="bg-white border border-slate-100 rounded-[2rem] p-8 max-w-sm w-full shadow-2xl relative animate-in zoom-in-95 flex flex-col items-center text-center">
                 <CheckCircle2 size={56} className="text-green-500 mb-4" />
                 <h3 className="text-2xl font-bold text-slate-900 mb-2">Saved!</h3>
                 <p className="text-slate-500 mb-1 text-sm">{exportSummary.filename}</p>
                 <p className="text-slate-400 mb-6 text-xs">{exportSummary.size} • {exportSummary.resolution}</p>
                 <button onClick={() => setExportSummary(null)} className="w-full py-3.5 bg-slate-900 text-white font-bold rounded-xl hover:bg-slate-800">Done</button>
             </div>
         </div>
      )}

      {step === 'upload' ? (
        <div className="flex-1 flex flex-col items-center justify-center p-6 relative z-10">
             <h1 className="text-5xl md:text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-purple-600 mb-4 tracking-tighter text-center">Enhance.</h1>
             <p className="text-slate-500 mb-10 text-center max-w-xs md:max-w-md">Professional video upscaling and restoration powered by WebGL.</p>
             <div 
                className="w-full max-w-lg aspect-video bg-white/60 backdrop-blur-xl border-2 border-dashed border-indigo-200 rounded-[2rem] flex flex-col items-center justify-center cursor-pointer hover:border-indigo-500 transition-all shadow-xl active:scale-95"
                onClick={() => fileInputRef.current?.click()}
             >
                <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mb-4"><Upload size={28} /></div>
                <h3 className="text-lg font-bold text-slate-800">Upload Video</h3>
                <p className="text-slate-400 text-sm mt-1">Tap to browse</p>
                <input ref={fileInputRef} type="file" accept="video/mp4,video/webm,video/quicktime" className="hidden" onChange={handleFileChange} />
             </div>
        </div>
      ) : (
        <>
            {/* RESPONSIVE HEADER */}
            <div className="flex-none px-4 py-4 md:px-8 md:py-6 flex items-center justify-between z-30 pointer-events-none">
                <div className="pointer-events-auto bg-white/80 backdrop-blur-md px-3 py-1.5 md:px-4 md:py-2 rounded-full border border-white/20 shadow-sm flex items-center gap-3 max-w-[60%]">
                     <button onClick={() => { setVideoSrc(null); setStep('upload'); }} className="text-slate-400 hover:text-slate-900 p-1"><Undo2 size={18}/></button>
                     <div className="h-3 w-px bg-slate-200"></div>
                     <div className="flex flex-col min-w-0">
                         <span className="text-xs md:text-sm font-bold text-slate-700 truncate leading-tight">{originalFileName}</span>
                         <span className="text-[10px] text-slate-400 font-medium leading-tight">{fileSizeStr}</span>
                     </div>
                </div>
                
                <div className="pointer-events-auto relative">
                     <button onClick={() => setShowExportMenu(!showExportMenu)} className={`flex items-center gap-2 bg-slate-900 text-white px-3 py-1.5 md:px-4 md:py-2 rounded-full text-xs font-bold shadow-lg transition-transform hover:bg-slate-800 active:scale-95`}> 
                        <Download size={14} /> <span className="hidden md:inline">Download</span> <ChevronDown size={14}/>
                     </button>
                     {showExportMenu && (
                        <div className="absolute top-full right-0 mt-2 w-48 bg-white rounded-2xl shadow-xl border border-slate-100 p-1 z-50 animate-in fade-in slide-in-from-top-2">
                            <button onClick={() => initiateExport('original')} className="w-full text-left px-3 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 rounded-lg flex justify-between items-center">Original <Share2 size={14} className="text-slate-300"/></button>
                            <div className="h-px bg-slate-50 my-1"></div>
                            {/* Removed 2K and 4K options */}
                            <button onClick={() => initiateExport('1080p')} className="w-full text-left px-3 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 rounded-lg flex justify-between items-center">1080p <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">HD</span></button>
                        </div>
                     )}
                </div>
            </div>

            {/* MAIN STAGE */}
            <div 
                className="flex-1 relative flex flex-col items-center justify-center overflow-hidden pb-28 md:pb-40 z-10 w-full touch-none"
                onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
                onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}
            >
                 <div className="relative w-full max-w-6xl aspect-video md:shadow-2xl md:shadow-indigo-900/20 md:rounded-2xl overflow-hidden bg-slate-900">
                    <video ref={videoRef} src={videoSrc || ''} className="absolute opacity-0 pointer-events-none" onLoadedMetadata={handleMetadataLoaded} onLoadedData={handleVideoLoaded} onTimeUpdate={handleTimeUpdate} onEnded={() => setMode(ProcessingMode.PAUSED)} playsInline loop muted={isMuted} crossOrigin="anonymous" />
                    
                    <canvas ref={canvasRef} className={`w-full h-full object-contain ${isSplitView ? 'cursor-ew-resize' : zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`} />
                    <canvas ref={exportCanvasRef} className="fixed top-0 left-0 pointer-events-none opacity-0 -z-50" />

                    {/* OVERLAYS */}
                    <div className="absolute top-4 right-4 md:top-6 md:right-6 flex flex-col gap-3 z-20 pointer-events-none">
                         {isEnhanced && !isComparing && !isSplitView && (
                            <div className="bg-indigo-600/90 backdrop-blur text-white px-3 py-1.5 md:px-4 md:py-2 rounded-full text-[10px] md:text-xs font-bold shadow-lg flex items-center gap-2 self-end animate-in fade-in slide-in-from-right"><Sparkles size={12} className="text-yellow-300" /> ENHANCED</div>
                        )}
                        {isComparing && (
                            <div className="bg-slate-700/90 backdrop-blur text-white px-3 py-1.5 md:px-4 md:py-2 rounded-full text-[10px] md:text-xs font-bold shadow-lg flex items-center gap-2 self-end animate-in fade-in slide-in-from-right"><Eye size={12} /> ORIGINAL</div>
                        )}
                    </div>

                    {/* SLIDER HANDLE */}
                    {isSplitView && (
                        <div 
                            className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_15px_rgba(0,0,0,0.5)] cursor-ew-resize z-30 pointer-events-none"
                            style={{ left: `${sliderPos * 100}%` }}
                        >
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-9 h-9 bg-white rounded-full shadow-xl flex items-center justify-center">
                                <SplitSquareHorizontal size={18} className="text-slate-900" />
                            </div>
                        </div>
                    )}

                 </div>
            </div>

            {/* RESPONSIVE CONTROL DECK */}
            <div className="fixed bottom-4 left-3 right-3 md:bottom-10 md:left-1/2 md:right-auto md:-translate-x-1/2 md:w-full md:max-w-3xl z-40">
                <div className="bg-white/95 backdrop-blur-xl border border-white/40 rounded-3xl p-3 md:p-5 shadow-2xl shadow-indigo-900/10 flex flex-col gap-2 md:gap-4">
                    
                    {/* Progress Bar */}
                    <div className="flex items-center gap-3 px-1">
                        <span className="text-[10px] md:text-xs font-mono font-bold text-slate-400 w-10 text-right">{formatTime(currentTime)}</span>
                         <input type="range" min={0} max={duration || 100} value={currentTime} onChange={handleSeek} className="flex-1 h-1.5 md:h-2 bg-slate-200 rounded-full appearance-none cursor-pointer accent-indigo-600 touch-none" />
                        <span className="text-[10px] md:text-xs font-mono font-bold text-slate-400 w-10">{formatTime(duration)}</span>
                    </div>

                    {/* Buttons Grid */}
                    <div className="grid grid-cols-5 gap-2 items-center">
                         {/* Left: Utility */}
                         <div className="col-span-1 flex justify-start">
                            <button onClick={toggleMute} className="w-10 h-10 md:w-12 md:h-12 flex items-center justify-center rounded-2xl bg-slate-50 text-slate-500 hover:bg-slate-100 transition-colors active:scale-95">{isMuted ? <VolumeX size={18}/> : <Volume2 size={18}/>}</button>
                         </div>
                         
                         {/* Center: Play */}
                         <div className="col-span-3 flex justify-center gap-4">
                            <button onClick={handleZoomReset} className="w-10 h-10 md:w-12 md:h-12 flex items-center justify-center rounded-2xl text-slate-400 hover:bg-slate-50 hidden md:flex"><RotateCcw size={18}/></button>

                            <button onClick={togglePlay} className="w-16 h-12 md:w-20 md:h-14 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-600/20 active:scale-95 transition-all">
                                {mode === ProcessingMode.PLAYING ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1"/>}
                            </button>

                            <button onClick={handleZoomIn} className="w-10 h-10 md:w-12 md:h-12 flex items-center justify-center rounded-2xl text-slate-400 hover:bg-slate-50 hidden md:flex"><ZoomIn size={20}/></button>
                         </div>

                         {/* Right: Enhance Tools */}
                         <div className="col-span-1 flex justify-end">
                            {isEnhanced ? (
                                <div className="flex gap-2">
                                     <button 
                                        onClick={toggleSplitView} 
                                        className={`w-10 h-10 md:w-12 md:h-12 flex items-center justify-center rounded-2xl border transition-colors ${isSplitView ? 'bg-indigo-100 text-indigo-600 border-indigo-200' : 'bg-white text-slate-500 border-slate-200'}`} 
                                        title="Compare"
                                     >
                                         <SplitSquareHorizontal size={18}/>
                                     </button>
                                     <button onClick={toggleEnhance} className="hidden md:flex items-center gap-2 px-4 h-12 rounded-2xl font-bold text-sm bg-gradient-to-r from-pink-500 to-indigo-500 text-white shadow-lg active:scale-95"><Sparkles size={16} /> ON</button>
                                     <button onClick={toggleEnhance} className="md:hidden w-10 h-10 flex items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg"><Sparkles size={18} /></button>
                                </div>
                            ) : (
                                <button onClick={toggleEnhance} className="flex items-center justify-center gap-2 w-10 md:w-auto md:px-5 h-10 md:h-12 rounded-2xl font-bold text-sm bg-slate-100 text-slate-600 hover:bg-slate-200 active:scale-95 transition-all">
                                    <Wand2 size={18} className="text-indigo-600" /> <span className="hidden md:inline">Enhance</span>
                                </button>
                            )}
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