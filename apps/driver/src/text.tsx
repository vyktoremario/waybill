import { StyleSheet, Text as RNText, type TextProps, type TextStyle } from 'react-native';

/** Font files loaded in App.tsx (Manifest: Space Grotesk headings, Inter body, JetBrains Mono numbers). */
export const FONTS = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  display: 'SpaceGrotesk_700Bold',
  mono: 'JetBrainsMono_600SemiBold',
} as const;

/**
 * Custom fonts on React Native don't follow fontWeight (each weight is its own family), so this maps the
 * weight in a style to the right Inter file, and large bold text to Space Grotesk.
 */
function familyFor(s: TextStyle): string {
  const w = String(s.fontWeight ?? '400');
  if ((w === '700' || w === '800' || w === 'bold') && (s.fontSize ?? 0) >= 22) return FONTS.display;
  if (w === '700' || w === '800' || w === '900' || w === 'bold') return FONTS.bold;
  if (w === '600') return FONTS.semibold;
  if (w === '500') return FONTS.medium;
  return FONTS.regular;
}

export function Text({ style, ...props }: TextProps) {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const fontFamily = flat.fontFamily ?? familyFor(flat);
  return <RNText {...props} style={[style, { fontFamily, fontWeight: 'normal' }]} />;
}
