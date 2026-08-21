// Home: large left-aligned action tiles, silent on mount.
// VoiceOver reads each tile's accessible name (title + spoken hint); the icon is
// decorative. The hint is now also shown visually so low-vision users get the
// same guidance the screen reader speaks.

import type { ReactNode } from 'react';
import { Screen } from '../components';
import { ScreenProps, Route } from '../nav';
import { DEMO_MENU, DEMO_RESTAURANT_NAME } from '../lib/demoMenu';

function Tile({
  icon,
  title,
  sub,
  onClick,
  primary,
}: {
  icon: ReactNode;
  title: string;
  sub: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      className={`action-tile${primary ? ' action-tile--primary' : ''}`}
      onClick={onClick}
      aria-label={`${title}. ${sub}`}
    >
      <span className="action-tile__icon" aria-hidden="true">{icon}</span>
      <span className="action-tile__body">
        <span className="action-tile__title">{title}</span>
        <span className="action-tile__sub">{sub}</span>
      </span>
      <svg className="action-tile__chev" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export default function HomeScreen({ navigate }: ScreenProps) {
  const go = (route: Route) => () => navigate(route);

  return (
    <Screen>
      <div className="home-hero">
        <h1 className="title">Meet My Menu AI</h1>
      </div>

      <div className="col home-actions stagger">
        <Tile
          primary
          title="Read a Menu"
          sub="Scan it with your camera, or find it online"
          onClick={go({ name: 'getMenu' })}
          icon={
            <svg width="26" height="26" viewBox="0 0 24 24" {...stroke}>
              <path d="M3 9V7a2 2 0 012-2h2M17 5h2a2 2 0 012 2v2M21 15v2a2 2 0 01-2 2h-2M7 19H5a2 2 0 01-2-2v-2" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
          }
        />
        <Tile
          title="Saved Restaurants"
          sub="Open a menu you already saved"
          onClick={go({ name: 'saved' })}
          icon={
            <svg width="26" height="26" viewBox="0 0 24 24" {...stroke}>
              <path d="M6 4h12a1 1 0 011 1v15l-7-4-7 4V5a1 1 0 011-1z" />
            </svg>
          }
        />
        <Tile
          title="Demo Menu"
          sub="Open a sample menu, no camera or scan needed"
          onClick={go({ name: 'conversation', menu: DEMO_MENU, restaurantName: DEMO_RESTAURANT_NAME, source: 'photo' })}
          icon={
            <svg width="26" height="26" viewBox="0 0 24 24" {...stroke}>
              <path d="M8 5.5v13l11-6.5-11-6.5z" />
            </svg>
          }
        />
      </div>

    </Screen>
  );
}
