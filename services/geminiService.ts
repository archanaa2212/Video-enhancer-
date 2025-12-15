import { GoogleGenAI, Type } from "@google/genai";
import { AnalysisResult } from "../types";

const apiKey = process.env.API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey || '' });

/**
 * Analyzes a single video frame to determine optimal enhancement settings.
 * @param base64Image Base64 encoded image string (JPEG).
 * @returns AnalysisResult containing detected features and suggested adjustments.
 */
export async function analyzeFrame(base64Image: string): Promise<AnalysisResult> {
  if (!apiKey) throw new Error("API Key not found");

  const prompt = `Analyze this video frame for cosmetic and visual enhancement.
  
  Determine values (0-200 scale, default 100):
  - brightness: Increase if dark.
  - contrast: Increase for definition.
  - saturation: Increase for vibrance (especially if lips are visible).
  - sharpen: 0-100. IMPORTANT: If hair, ears, or nose details are blurry, increase this.
  - denoise: 0-100. If skin is visible, increase to smooth it.
  
  Detect specific cosmetic features:
  - "lipsDetected": Are lips clearly visible? (To enhance red tones).
  - "teethDetected": Are teeth visible? (To enhance white clarity).
  - "hairDetected": Is hair texture visible?
  - "faceFeaturesDetected": Eyes, Nose, Ears visible?
  - "skinDetected": Is skin visible?

  Provide a short "reasoning" string.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: {
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
        { text: prompt }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          brightness: { type: Type.INTEGER },
          contrast: { type: Type.INTEGER },
          saturation: { type: Type.INTEGER },
          sharpen: { type: Type.INTEGER },
          denoise: { type: Type.INTEGER },
          warmth: { type: Type.INTEGER },
          vignette: { type: Type.INTEGER },
          detectedShade: { type: Type.STRING },
          hairDetected: { type: Type.BOOLEAN },
          faceFeaturesDetected: { type: Type.BOOLEAN },
          skinDetected: { type: Type.BOOLEAN },
          lipsDetected: { type: Type.BOOLEAN },
          teethDetected: { type: Type.BOOLEAN },
          skinTone: { type: Type.STRING },
          natureDetected: { type: Type.BOOLEAN },
          boostVibrance: { type: Type.BOOLEAN },
          isLowLight: { type: Type.BOOLEAN },
          needsHighlightBoost: { type: Type.BOOLEAN },
          animalDetected: { type: Type.BOOLEAN },
          grainDetected: { type: Type.BOOLEAN },
          reasoning: { type: Type.STRING },
        },
        required: ["brightness", "contrast", "saturation", "sharpen", "denoise", "warmth", "detectedShade", "reasoning"]
      }
    }
  });

  const text = response.text;
  if (!text) throw new Error("No response from AI");

  try {
    const result = JSON.parse(text) as AnalysisResult;
    return result;
  } catch (e) {
    console.error("Failed to parse AI response", e);
    // Return safe defaults
    return {
      brightness: 100, contrast: 100, saturation: 100, sharpen: 0, denoise: 0, warmth: 100, vignette: 0,
      detectedShade: "Standard", hairDetected: false, faceFeaturesDetected: false, skinDetected: false,
      lipsDetected: false, teethDetected: false,
      natureDetected: false, boostVibrance: false, isLowLight: false, needsHighlightBoost: false,
      animalDetected: false, grainDetected: false, reasoning: "Analysis failed, using defaults."
    };
  }
}

// Keep existing helper if needed elsewhere
export async function extractFramesFromVideo(videoFile: File): Promise<string[]> {
    return []; 
}
export async function enhanceVideo(videoFile: File, mimeType: string, base64: string, setMsg: any): Promise<string> {
    return "";
}