// Chooser between scanning a paper menu and finding one online. This screen
// stays silent so VoiceOver remains the only voice outside Conversation Mode.

import type { ReactNode } from 'react';
import { Screen, Title, Body, SecondaryButton } from '../components';
import { ScreenProps } from '../nav';

function ChoiceTile({
  title,
  sub,
  onClick,
  primary,
  icon,
}: {
  title: string;
  sub: string;
  onClick: () => void;
  primary?: boolean;
  icon: ReactNode;
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

export default function GetMenuScreen({ navigate, goBack }: ScreenProps) {
  return (
    <Screen label="Choose how to read a menu">
      <Title>Read a Menu</Title>
      <Body>Scan a menu you have, or find one online.</Body>

      <div className="col home-actions">
        <ChoiceTile
          primary
          title="Scan a Menu"
          sub="Use your camera"
          onClick={() => navigate({ name: 'capture' })}
          icon={
            <svg width="26" height="26" viewBox="0 0 24 24" {...stroke}>
              <path d="M3 9V7a2 2 0 012-2h2M17 5h2a2 2 0 012 2v2M21 15v2a2 2 0 01-2 2h-2M7 19H5a2 2 0 01-2-2v-2" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
          }
        />
        <ChoiceTile
          title="Find a Menu"
          sub="Search by name or link"
          onClick={() => navigate({ name: 'find' })}
          icon={
            <svg width="26" height="26" viewBox="0 0 24 24" {...stroke}>
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.2-3.2" />
            </svg>
          }
        />
      </div>

      <div className="spacer" />
      <SecondaryButton label="Back" hint="Return to the home screen" onClick={goBack} />
    </Screen>
  );
}
