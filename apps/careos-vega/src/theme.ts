// Palette from the CareOS plan. Crimson is reserved for alerts/locks.
export const colors = {
  slate: '#0B0F19',
  panel: '#151B2B',
  text: '#F3F4F6',
  textDim: '#9CA3AF',
  crimson: '#EF4444',
  emerald: '#10B981',
  teal: '#06B6D4',
  amber: '#D97706',
  focus: '#FFFFFF',
} as const;

// 10-foot UI sizes (dp). Layout is flex-based; no absolute positioning or hardcoded canvas size.
export const type = {
  caption: 24,
  body: 30,
  title: 44,
  display: 72,
} as const;

export const space = {xs: 8, sm: 16, md: 24, lg: 40, xl: 64} as const;
