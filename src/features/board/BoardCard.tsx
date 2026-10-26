import Ionicons from '@expo/vector-icons/Ionicons';
import { useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import type { LeadListItem } from '@/features/leads/api';
import { papersBadge } from '@/features/papers/api';
import { visitBadge } from '@/features/visits/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

// =====================================================================
// One lead on the board: a flip card
//   Front: name, rating, next call, papers / visit, assignee
//   Back:  phone, courses, source, last contact + Call / WhatsApp / SMS
//   Tap = open the lead · long press = actions · ⟳ = flip
// =====================================================================

export const CARD_HEIGHT = 132;

const RATING_COLOR: Record<string, string> = {
  hot: colors.hot,
  warm: colors.warm,
  cold: colors.cold,
};

const WHATSAPP_GREEN = '#25D366';

function shortWhen(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? `Today ${time}`
    : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

function daysAgo(iso: string | null): string {
  if (!iso) return 'Never contacted';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'Contacted today';
  if (days === 1) return 'Contacted yesterday';
  return `Contacted ${days} days ago`;
}

type Props = {
  lead: LeadListItem;
  showAssignee: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onCall: () => void;
  onWhatsApp: () => void;
  onSms: () => void;
};

export function BoardCard({ lead, showAssignee, onPress, onLongPress, onCall, onWhatsApp, onSms }: Props) {
  const turn = useRef(new Animated.Value(0)).current;
  const [flipped, setFlipped] = useState(false);

  const flip = () => {
    Animated.spring(turn, { toValue: flipped ? 0 : 1, friction: 8, tension: 60, useNativeDriver: true }).start();
    setFlipped((f) => !f);
  };

  const front = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const back = turn.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] });

  const ratingColor = lead.rating ? RATING_COLOR[lead.rating] : null;
  const kind = lead.stage?.kind ?? 'open';
  const overdue = !!lead.next_follow_up_at && new Date(lead.next_follow_up_at).getTime() < Date.now();
  const papers =
    kind === 'open' || kind === 'won'
      ? papersBadge(lead.papers_required ?? 0, (lead.papers_required ?? 0) - (lead.papers_missing ?? 0))
      : null;
  const visit = kind === 'open' ? visitBadge(lead.visit_status, lead.visit_at) : null;
  const courses = lead.lead_courses.map((c) => c.course?.name).filter(Boolean).join(', ');

  const flipButton = (
    <Pressable
      onPress={flip}
      hitSlop={10}
      style={styles.flipBtn}
      accessibilityRole="button"
      accessibilityLabel={flipped ? 'Show the front' : 'Show phone and details'}
    >
      <Ionicons name="sync" size={16} color={colors.textMuted} />
    </Pressable>
  );

  return (
    <View style={styles.wrap}>
      {/* Front */}
      <Animated.View
        style={[styles.face, ratingColor && { borderLeftColor: ratingColor, borderLeftWidth: 4 }, { transform: [{ perspective: 1000 }, { rotateY: front }] }]}
        pointerEvents={flipped ? 'none' : 'auto'}
        importantForAccessibility={flipped ? 'no-hide-descendants' : 'auto'}
      >
        <Pressable
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={350}
          style={({ pressed }) => [styles.body, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${lead.name}. Press and hold for actions`}
        >
          <View style={styles.top}>
            <Text style={styles.name} numberOfLines={1}>
              {lead.name}
            </Text>
            {lead.rating && ratingColor && (
              <Text style={[styles.rating, { color: ratingColor, borderColor: ratingColor }]}>
                {lead.rating.toUpperCase()}
              </Text>
            )}
          </View>

          <Text style={[styles.line, overdue && styles.overdue]} numberOfLines={1}>
            {lead.next_follow_up_at ? `${overdue ? '⚠ ' : '⏰ '}${shortWhen(lead.next_follow_up_at)}` : '⏰ No call set'}
          </Text>

          {(papers || visit) && (
            <View style={styles.badges}>
              {papers && (
                <Text style={[styles.badge, { color: papers.complete ? colors.success : colors.warning }]}>
                  {papers.text}
                </Text>
              )}
              {visit && (
                <Text style={[styles.badge, { color: colors.primary }]} numberOfLines={1}>
                  {visit}
                </Text>
              )}
            </View>
          )}

          {showAssignee && (
            <Text style={styles.assignee} numberOfLines={1}>
              👤 {lead.assignee?.full_name ?? 'Unassigned'}
            </Text>
          )}
        </Pressable>
        {flipButton}
      </Animated.View>

      {/* Back */}
      <Animated.View
        style={[styles.face, styles.backFace, { transform: [{ perspective: 1000 }, { rotateY: back }] }]}
        pointerEvents={flipped ? 'auto' : 'none'}
        importantForAccessibility={flipped ? 'auto' : 'no-hide-descendants'}
      >
        <Pressable
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={350}
          style={({ pressed }) => [styles.body, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${lead.name}, ${lead.phone}`}
        >
          <Text style={styles.phone} numberOfLines={1}>
            📞 {lead.phone}
          </Text>
          <Text style={styles.line} numberOfLines={1}>
            {courses ? `🎓 ${courses}` : '🎓 No course yet'}
          </Text>
          <Text style={styles.line} numberOfLines={1}>
            {lead.source?.name ? `📣 ${lead.source.name} · ` : ''}
            {daysAgo(lead.last_contacted_at)}
          </Text>

          <View style={styles.contact}>
            <ContactButton icon="call" color={colors.success} label={`Call ${lead.name}`} onPress={onCall} />
            <ContactButton icon="logo-whatsapp" color={WHATSAPP_GREEN} label={`WhatsApp ${lead.name}`} onPress={onWhatsApp} />
            <ContactButton icon="chatbubble-ellipses" color={colors.info} label={`SMS ${lead.name}`} onPress={onSms} />
          </View>
        </Pressable>
        {flipButton}
      </Animated.View>
    </View>
  );
}

function ContactButton({
  icon,
  color,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.contactBtn, { backgroundColor: color + '1A' }, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={18} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { height: CARD_HEIGHT },
  face: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    backfaceVisibility: 'hidden',
    overflow: 'hidden',
  },
  backFace: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  body: { flex: 1, padding: spacing.md, paddingRight: spacing.xl + spacing.sm, gap: 6 },
  pressed: { opacity: 0.7 },
  top: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1, fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text },
  rating: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  line: { fontSize: fontSize.caption, color: colors.textMuted },
  overdue: { color: colors.danger, fontWeight: fontWeight.bold },
  badges: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'nowrap' },
  badge: { fontSize: 11, fontWeight: fontWeight.bold, flexShrink: 1 },
  assignee: { fontSize: 11, color: colors.textMuted },
  phone: { fontSize: fontSize.body, fontWeight: fontWeight.bold, color: colors.text, letterSpacing: 0.5 },
  contact: { flexDirection: 'row', gap: spacing.sm, marginTop: 'auto' },
  contactBtn: { width: 36, height: 32, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  flipBtn: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
