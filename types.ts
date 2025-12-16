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
  resolution: 'original' | '1080p'; // Changed from 'original' | '1080p' | '720p' | '480p' and App.tsx's 'original' | '1080p' | '2k'
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
  lipsDetected: boolean;
  teethDetected: boolean;
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