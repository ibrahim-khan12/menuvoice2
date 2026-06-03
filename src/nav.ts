import { ParsedMenu } from './types';

// Lightweight route model. We avoid react-navigation to keep the Expo Go
// dependency surface tiny; a prototype with six screens does not need it.

export type Route =
  | { name: 'home' }
  | { name: 'capture' }
  | { name: 'url' }
  | { name: 'conversation'; menu: ParsedMenu; restaurantName: string }
  | { name: 'saved' }
  | { name: 'settings' };

export type Navigate = (route: Route) => void;

export interface ScreenProps {
  navigate: Navigate;
  goBack: () => void;
}
