export interface Voice {
  id: string;
  label: string;
  gender: "male" | "female" | "neutral";
}

// Curated from MiniMax's canonical System Voice ID list. Browse the full
// catalog (332 voices, 24 languages) at:
//   https://platform.minimax.io/docs/faq/system-voice-id
// All voice_id values below are verified against that table (gender is a UI
// hint inferred from the label — MiniMax's API has no gender field).
export const VOICES: Voice[] = [
  { id: "English_magnetic_voiced_man", label: "Magnetic-voiced Male", gender: "male" },
  { id: "English_Trustworth_Man", label: "Trustworthy Man", gender: "male" },
  { id: "English_ManWithDeepVoice", label: "Man With Deep Voice", gender: "male" },
  { id: "English_Deep-VoicedGentleman", label: "Deep-voiced Gentleman", gender: "male" },
  { id: "English_PatientMan", label: "Patient Man", gender: "male" },
  { id: "English_Aussie_Bloke", label: "Aussie Bloke", gender: "male" },
  { id: "English_Jovialman", label: "Jovial Man", gender: "male" },
  { id: "English_Graceful_Lady", label: "Graceful Lady", gender: "female" },
  { id: "English_CalmWoman", label: "Calm Woman", gender: "female" },
  { id: "English_Upbeat_Woman", label: "Upbeat Woman", gender: "female" },
  { id: "English_LovelyGirl", label: "Lovely Girl", gender: "female" },
  { id: "English_Wiselady", label: "Wise Lady", gender: "female" },
  { id: "English_ConfidentWoman", label: "Confident Woman", gender: "female" },
  { id: "English_SereneWoman", label: "Serene Woman", gender: "female" },
  { id: "English_MaturePartner", label: "Mature Partner", gender: "neutral" },
  { id: "English_CaptivatingStoryteller", label: "Captivating Storyteller", gender: "neutral" },
  { id: "English_WiseScholar", label: "Wise Scholar", gender: "neutral" },
  { id: "English_Comedian", label: "Comedian", gender: "neutral" },
];

export const DEFAULT_VOICE_ID = "English_ManWithDeepVoice";
