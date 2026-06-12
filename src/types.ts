export interface UserProfile {
  email: string;
  name: string;
  allergies: string[];
  dislikes: string[];
  spiceTolerance: 'none' | 'mild' | 'medium' | 'hot';
  cuisinesLiked: string[];
  pastOrders: string[]; // dishes the guest decided on before — feeds recommendations
  hidePrices: boolean;
  ttsVoice: string;
  onboarded: boolean;
  imageLogging: boolean;
  appVoice?: boolean; // app TTS on/off; off lets VoiceOver speak without overlap
}

export interface MenuItem {
  name: string;
  description?: string;
  price?: string;
  ingredients?: string[];
}

export interface MenuCategory {
  name: string;
  items: MenuItem[];
}

export interface ParsedMenu {
  categories: MenuCategory[];
  notes?: string;
  restaurantName?: string; // extracted from the menu photos if visible
  incomplete?: boolean; // model judged the menu partial (cut off, missing sections)
}

export interface SavedRestaurant {
  id: string;
  name: string;
  menu: ParsedMenu;
  capturedAt: string; // ISO date
}

export interface ChatTurn {
  role: 'assistant' | 'user';
  text: string;
}

export const EMPTY_PROFILE: UserProfile = {
  email: '',
  name: '',
  allergies: [],
  dislikes: [],
  spiceTolerance: 'medium',
  cuisinesLiked: [],
  pastOrders: [],
  hidePrices: false,
  ttsVoice: 'shimmer',
  onboarded: false,
  imageLogging: false,
};
