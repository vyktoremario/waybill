import type { ReactNode } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from './text';
import type { SyncState } from './sync';
import { c } from './theme';

export function Button({ label, onPress, kind = 'primary', disabled, style, icon }: { label: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger-link' | 'link'; disabled?: boolean; style?: StyleProp<ViewStyle>; icon?: keyof typeof Feather.glyphMap }) {
  const s = kind === 'primary' ? (disabled ? styles.primaryDisabled : styles.primary) : kind === 'secondary' ? styles.secondary : styles.link;
  const t = kind === 'primary' ? (disabled ? styles.primaryDisabledText : styles.primaryText) : kind === 'secondary' ? styles.secondaryText : kind === 'danger-link' ? styles.dangerLinkText : styles.linkText;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [s, pressed && !disabled && { opacity: 0.85 }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {icon ? <Feather name={icon} size={kind === 'primary' ? 20 : 18} color={(StyleSheet.flatten(t) as { color?: string }).color} /> : null}
        <Text style={t}>{label}</Text>
      </View>
    </Pressable>
  );
}

/** Always-visible connection state (ADR-0006 UI rules). */
export function ConnectionBanner({ s, onToggleDemoOffline, demoOffline }: { s: SyncState; onToggleDemoOffline?: () => void; demoOffline?: boolean }) {
  const waiting = s.pending;
  let tone = styles.bannerOnline;
  let text = 'Online';
  let ink = c.ink;
  if (!s.online) {
    tone = styles.bannerOffline;
    ink = c.attentionInk;
    text = waiting ? `Offline · ${waiting} action${waiting === 1 ? '' : 's'} waiting to sync` : 'Offline · you can keep working';
  } else if (s.syncing && waiting) {
    tone = styles.bannerSyncing;
    ink = c.cobaltDark;
    text = `Syncing ${waiting} action${waiting === 1 ? '' : 's'}…`;
  } else if (waiting) {
    tone = styles.bannerSyncing;
    ink = c.cobaltDark;
    text = `${waiting} action${waiting === 1 ? '' : 's'} waiting to sync`;
  }
  return (
    <View style={[styles.banner, tone]} accessibilityRole="summary" accessibilityLabel={text}>
      {!s.online ? <Feather name="wifi-off" size={18} color={ink} /> : s.syncing || waiting ? <Feather name="refresh-cw" size={16} color={ink} /> : <View style={[styles.dot, { backgroundColor: c.done }]} />}
      <Text style={[styles.bannerText, { color: ink }]}>{text}</Text>
      {onToggleDemoOffline && (
        <Pressable onPress={onToggleDemoOffline} accessibilityRole="button" hitSlop={12} style={{ marginLeft: 'auto' }}>
          <Text style={[styles.bannerLink, { color: ink }]}>{demoOffline ? 'Go online' : 'Demo: go offline'}</Text>
        </Pressable>
      )}
    </View>
  );
}

export function StepRow({ label, state, right }: { label: string; state: 'done' | 'now' | 'next'; right?: string }) {
  return (
    <View style={[styles.step, state === 'now' && { backgroundColor: c.cobaltTint }]}>
      <View style={[styles.stepDot, state === 'done' ? styles.stepDone : state === 'now' ? styles.stepNow : styles.stepNext]}>{state === 'done' && <Feather name="check" size={14} color="#fff" />}</View>
      <Text style={[styles.stepText, state === 'now' && { fontWeight: '700' }, state === 'next' && { color: c.muted }]}>{label}</Text>
      {right ? <Text style={[styles.stepRight, state === 'now' && { color: c.cobalt }]}>{right}</Text> : null}
    </View>
  );
}

export function Card({ children, strong, style }: { children: ReactNode; strong?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[strong ? styles.cardStrong : styles.card, style]}>{children}</View>;
}

export const styles = StyleSheet.create({
  primary: { minHeight: 64, borderRadius: 14, backgroundColor: c.cobalt, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { color: '#fff', fontSize: 19, fontWeight: '700' },
  primaryDisabled: { minHeight: 64, borderRadius: 14, backgroundColor: c.disabledBg, alignItems: 'center', justifyContent: 'center' },
  primaryDisabledText: { color: c.disabledInk, fontSize: 19, fontWeight: '700' },
  secondary: { minHeight: 56, borderRadius: 12, borderWidth: 2, borderColor: c.ink, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  secondaryText: { color: c.ink, fontSize: 16, fontWeight: '600' },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  linkText: { color: c.ink, fontSize: 15, fontWeight: '600', textDecorationLine: 'underline' },
  dangerLinkText: { color: c.problem, fontSize: 15, fontWeight: '600', textDecorationLine: 'underline' },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1 },
  bannerOnline: { backgroundColor: c.surface, borderColor: c.line },
  bannerOffline: { backgroundColor: c.attentionSoft, borderColor: '#F59E0B' },
  bannerSyncing: { backgroundColor: c.cobaltSoft, borderColor: '#93AEEF' },
  bannerText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  bannerLink: { fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: c.lineSoft },
  stepDot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  stepDone: { backgroundColor: c.done },
  stepNow: { borderWidth: 3, borderColor: c.cobalt },
  stepNext: { borderWidth: 2, borderColor: '#AEB5C0' },
  check: { color: '#fff', fontSize: 13, fontWeight: '800' },
  stepText: { fontSize: 15, color: c.ink, flex: 1 },
  stepRight: { fontSize: 13, color: c.muted, fontWeight: '600' },
  card: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 12 },
  cardStrong: { backgroundColor: c.surface, borderWidth: 2, borderColor: c.ink, borderRadius: 12 },
});
