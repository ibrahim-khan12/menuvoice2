// MenuVoice design tokens — mirrors CSS custom properties in index.css.
// WCAG AAA contrast throughout. Minimum 64×64 touch targets.

export const colors = {
  bg:           '#0d0d0f',
  surface:      '#18181c',
  surfaceHigh:  '#222227',
  surfaceUser:  '#261e1a',

  textPrimary:   '#f4f2ed',  // ~17:1 on bg (AAA)
  textSecondary: '#c8c5bd',  // ~11:1 on bg (AAA)
  textMuted:     '#9e9a91',  // ~7:1  on bg (AAA)

  accent:      '#ffb454',
  accentWarm:  '#ffc47a',
  accentText:  '#0d0d0f',

  focus:   '#ffd08a',
  danger:  '#ff6b6b',
  success: '#6dd68a',

  border: '#2a2a32',
};

export const type = {
  display:    36,
  heading:    22,
  subheading: 20,
  body:       17,
  button:     18,
  caption:    14,
};

export const space = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 36,
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 22,
};

export const TOUCH_MIN = 64;
