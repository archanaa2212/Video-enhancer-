export interface FilterState {
  brightness: number;
  contrast: number;
  saturation: number;
  sharpen: number;
  denoise: number;
  warmth: number;
}

export enum ProcessingMode {
  IDLE = 'idle',
  PLAYING = 'playing',
  PAUSED = 'paused',
  ANALYZING = 'analyzing',
  EXPORTING = 'exporting'
}

export interface ExportConfig {
  filename: string;
  format: 'mp4' | 'webm';
  resolution: 'original' | '1080p' | '720p' | '480p';
  fps: 24 | 30 | 60;
  quality: 'low' | 'medium' | 'high' | 'ultra';
}

export interface AnalysisResult {
  brightness: number;
  contrast: number;
  saturation: number;
  sharpen: number;
  denoise: number;
  warmth: number;
  vignette: number;
  detectedShade: string;
  hairDetected: boolean;
  faceFeaturesDetected: boolean;
  skinDetected: boolean;
  lipsDetected: boolean;  // New: For lip color enhancement
  teethDetected: boolean; // New: For teeth whitening/clarity
  skinTone?: string;
  natureDetected: boolean;
  boostVibrance: boolean;
  isLowLight: boolean;
  needsHighlightBoost: boolean;
  animalDetected: boolean;
  grainDetected: boolean;
  reasoning: string;
  movementLevel?: 'static' | 'moderate' | 'high';
}