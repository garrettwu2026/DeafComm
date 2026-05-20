import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: 'xxx' });
console.log(Object.keys(ai.live));
