import { memo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { stageBadge } from '@/features/approval/api';
import { feeBadge } from '@/features/fees/api';
import { MIcon, md, type MIconName } from '@/features/home/md';
import type { LeadListItem } from '@/features/leads/api';
import { contactLabel, whatsAppOnly } from '@/features/leads/contact';
import { whenChip } from '@/features/leads/design';
import { Highlighted } from '@/features/leads/Highlighted';
import { ago, callDot, callLineText, daysSince } from '@/features/leads/lastActivity';
import { otherMatch } from '@/features/leads/search';
import { papersBadge } from '@/features/papers/api';
import type { TemplateChannel } from '@/features/templates/api';
import { visitBadge } from '@/features/visits/api';
import { clock } from '@/features/voice/format';
import { isWeb } from '@/features/web/api';
import { colors, fontWeight } from '@/shared/theme';

// =====================================================================
// 🗂✨ One lead on the new list: an avatar with the rating's ring, the
//   name and stage, course · source · owner, one line of the latest
//   (note / call / visit), the next-call time and Call / WhatsApp.
//   Tap = open · press and hold = mark · hold Call = SMS
// =====================================================================

const RING: Record<string, string> = { hot: colors.hot, warm: colors.warm, cold: colors.cold };

const AVATAR = [
  [md.primaryC, md.onPrimaryC],
  [md.peachC, md.onPeachC],
  [md.okC, md.onOkC],
  [md.warnC, md.onWarnC],
  [md.purpleC, md.onPurpleC],
];

const CLOSED: Record<string, { label: string; color: string }> = {
  won: { label: 'Admitted', color: colors.success },
  lost: { label: 'Lost', color: colors.danger },
  cancelled: { label: 'Cancelled', color: colors.textMuted },
};

type Props = {
  lead: LeadListItem;
  search?: string;
  /** 📞📝 The latest line (call / note) */
  detailed?: boolean;
  staleDays?: number;
  nameOf?: (id: string | null) => string | null;
  onPeek?: () => void;
  onPlayVoice?: (fileId: string, seconds: number | null) => void;
  student?: boolean;
  showAssignee: boolean;
  selecting: boolean;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onCall: () => void;
  onWhatsApp: () => void;
  onSms: () => void;
  onTemplate?: (channel: TemplateChannel) => void;
  onPay?: () => void;
};

function ModernLeadCardBase({
  lead,
  search = '',
  detailed = true,
  staleDays = 0,
  nameOf = () => null,
  onPeek,
  onPlayVoice,
  student = false,
  showAssignee,
  selecting,
  selected,
  onPress,
  onLongPress,
  onCall,
  onWhatsApp,
  onSms,
  onTemplate,
  onPay,
}: Props) {
  const kind = lead.stage?.kind ?? 'open';
  const faded = kind === 'lost' || kind === 'cancelled';
  const ring = lead.rating ? RING[lead.rating] : null;
  const pal = AVATAR[[...lead.name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % AVATAR.length];

  // Stage chip (students: the approval step; closed leads: Admitted / Lost)
  const approval =
    student && kind === 'won' ? stageBadge(lead.approval_status, lead.registration_status, lead.listed_at) : null;
  const closed = !student && kind !== 'open' ? CLOSED[kind] : null;
  const chip = approval
    ? {
        label: approval.text,
        color: approval.color === 'good' ? colors.success : approval.color === 'bad' ? colors.danger : colors.warning,
      }
    : closed
      ? closed
      : !student && lead.stage
        ? { label: lead.stage.name, color: lead.stage.color }
        : null;

  // Line 2: course · source · owner (students: ID · course, batch, section)
  const courses = lead.lead_courses
    .map((c) => c.course?.name)
    .filter(Boolean)
    .join(', ');
  const admittedTo =
    kind === 'won' && lead.admitted_course
      ? [
          lead.admitted_course.name,
          lead.admitted_batch?.name,
          lead.admitted_section ? `Sec ${lead.admitted_section.name}` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;
  const meta = (
    student
      ? [
          lead.student_ref ? `🪪 ${lead.student_ref}` : null,
          lead.nu_admission_id ? `NU ${lead.nu_admission_id}` : null,
          admittedTo ?? courses,
        ]
      : [
          admittedTo ?? (courses || null),
          lead.source?.name ?? null,
          showAssignee ? (lead.assignee?.full_name?.split(' ')[0] ?? 'Unassigned') : null,
          // 🔍 the number shows while searching (it may be what matched)
          search ? (whatsAppOnly(lead) ? contactLabel(lead) : lead.phone) : null,
        ]
  )
    .filter(Boolean)
    .join(' · ');
  const matchLine = search ? otherMatch(lead, search) : null;

  // Line 3: the latest (a note, a voice note, a call, or ⏳ no contact)
  const last = lead.last;
  const since = daysSince(lead.last_contacted_at);
  const stale = kind === 'open' && staleDays > 0 && (since === null ? !last?.call_at : since >= staleDays);
  const noteVoice = last?.note_kind === 'voice' && !!last.note_voice_file;
  const noteNewer = !!last?.note_at && (!last.call_at || last.note_at >= last.call_at);
  let latest: { text: string; tone?: 'warn' | 'voice'; dot?: string } | null = null;
  if (detailed && last) {
    if (noteNewer && noteVoice)
      latest = {
        text: `🎙 Voice note${last.note_voice_sec ? ` · ${clock(last.note_voice_sec)}` : ''} ▶ · ${ago(last.note_at as string)}`,
        tone: 'voice',
      };
    else if (noteNewer && last.note_text) latest = { text: `📝 ${last.note_text}${last.note_more ? '…' : ''}` };
    else {
      const c = callLineText(last, nameOf);
      if (c) latest = { text: c, dot: callDot(last.call_outcome) };
    }
  }
  if (detailed && stale && !latest)
    latest = { text: since === null ? '🆕 Not called yet' : `⏳ No contact for ${since} days`, tone: 'warn' };

  // Small badges: papers, visit, fee
  const papers =
    kind === 'open' || kind === 'won'
      ? papersBadge(lead.papers_required ?? 0, (lead.papers_required ?? 0) - (lead.papers_missing ?? 0))
      : null;
  const visit = kind === 'open' ? visitBadge(lead.visit_status, lead.visit_at) : null;
  const visitLate =
    lead.visit_status === 'planned' && !!lead.visit_at && new Date(lead.visit_at).getTime() < Date.now();
  const fee = kind === 'open' || kind === 'won' ? feeBadge(lead) : null;
  const badges: { text: string; color: string }[] = [];
  if (visit)
    badges.push({
      text: visit,
      color: visitLate ? colors.danger : lead.visit_status === 'planned' ? colors.primary : colors.textMuted,
    });
  if (papers) badges.push({ text: papers.text, color: papers.complete ? colors.success : colors.warning });
  if (fee)
    badges.push({
      text: fee.text,
      color:
        fee.tone === 'bad'
          ? colors.danger
          : fee.tone === 'wait'
            ? colors.warning
            : fee.tone === 'good'
              ? colors.success
              : colors.text,
    });

  const when = kind === 'open' || student ? whenChip(lead.next_follow_up_at) : null;
  const phoneOk = !!lead.phone && !isWeb;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      android_ripple={{ color: md.ripple, foreground: true }}
      style={({ pressed }) => [
        styles.card,
        faded && !selected && styles.faded,
        selected && styles.selected,
        Platform.OS !== 'android' && pressed && styles.pressed,
      ]}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={`${lead.name}${chip ? `, ${chip.label}` : ''}${lead.rating ? `, ${lead.rating}` : ''}`}
    >
      {/* Avatar: the rating's colour ring; a tick when marked */}
      <View style={styles.avatarBox}>
        {selected ? (
          <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
            <MIcon name="check" size={22} color={colors.textOnPrimary} />
          </View>
        ) : (
          <View style={[styles.avatar, { backgroundColor: pal[0] }]}>
            <Text style={[styles.avatarText, { color: pal[1] }]}>{(lead.name.trim()[0] ?? '?').toUpperCase()}</Text>
          </View>
        )}
        {!!ring && !selected && <View style={[styles.ring, { borderColor: ring }]} />}
      </View>

      <View style={styles.body}>
        <View style={styles.row1}>
          <Highlighted text={lead.name} search={search} style={styles.name} />
          {!!chip && (
            <View style={[styles.stage, { backgroundColor: chip.color + '22' }]}>
              <Text style={[styles.stageText, { color: chip.color }]} numberOfLines={1}>
                {chip.label}
              </Text>
            </View>
          )}
        </View>
        {!!meta && <Highlighted text={meta} search={search} style={styles.meta} />}
        {!!matchLine && (
          <Text style={styles.meta} numberOfLines={1}>
            🔍 {matchLine}
          </Text>
        )}
        {!!latest && (
          <Pressable
            onPress={
              latest.tone === 'voice' && last
                ? () => onPlayVoice?.(last.note_voice_file as string, last.note_voice_sec)
                : onPeek
            }
            hitSlop={4}
            style={styles.latestRow}
            accessibilityRole="button"
            accessibilityHint={latest.tone === 'voice' ? 'Plays the voice note' : 'Shows the last calls and notes'}
          >
            {!!latest.dot && <View style={[styles.dot, { backgroundColor: latest.dot }]} />}
            <Text
              style={[
                styles.latest,
                latest.tone === 'warn' && styles.latestWarn,
                latest.tone === 'voice' && styles.latestVoice,
              ]}
              numberOfLines={1}
            >
              {latest.text}
            </Text>
          </Pressable>
        )}
        {badges.length > 0 && (
          <View style={styles.badges}>
            {badges.map((b) => (
              <Text
                key={b.text}
                style={[styles.badge, { color: b.color, backgroundColor: b.color + '14' }]}
                numberOfLines={1}
              >
                {b.text}
              </Text>
            ))}
          </View>
        )}
      </View>

      <View style={styles.right}>
        {!!when && (
          <Text style={[styles.when, when.late && styles.whenLate]} numberOfLines={1}>
            {when.text}
          </Text>
        )}
        {!selecting && (
          <View style={styles.actions}>
            {onPay && (
              <Round
                icon="payments"
                bg={md.okC}
                fg={md.onOkC}
                label={`Take payment from ${lead.name}`}
                onPress={onPay}
              />
            )}
            {phoneOk && (
              <Round
                icon="call"
                bg={md.okC}
                fg={md.onOkC}
                label={`Call ${lead.name}. Press and hold for SMS`}
                onPress={onCall}
                onLongPress={onSms}
              />
            )}
            <Round
              icon="chat"
              bg={md.waC}
              fg={md.onWaC}
              label={`WhatsApp ${lead.name}`}
              onPress={onWhatsApp}
              onLongPress={onTemplate ? () => onTemplate('whatsapp') : undefined}
            />
          </View>
        )}
      </View>
    </Pressable>
  );
}

export const ModernLeadCard = memo(ModernLeadCardBase);

function Round({
  icon,
  bg,
  fg,
  label,
  onPress,
  onLongPress,
}: {
  icon: MIconName;
  bg: string;
  fg: string;
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      hitSlop={4}
      android_ripple={{ color: 'rgba(0,0,0,0.12)', borderless: true, radius: 18 }}
      style={({ pressed }) => [
        styles.round,
        { backgroundColor: bg },
        Platform.OS !== 'android' && pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <MIcon name={icon} size={17} color={fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: 14,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    shadowColor: '#101840',
    shadowOpacity: 0.07,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  faded: { opacity: 0.65 },
  selected: {
    backgroundColor: md.meC,
    borderWidth: 2,
    borderColor: colors.primary,
    paddingVertical: 8,
    paddingLeft: 10,
    paddingRight: 6,
  },
  pressed: { opacity: 0.75 },
  avatarBox: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 15, fontWeight: fontWeight.semibold },
  ring: { position: 'absolute', top: -2, left: -2, right: -2, bottom: -2, borderRadius: 22, borderWidth: 2 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  row1: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  name: { flexShrink: 1, fontSize: 14.5, fontWeight: fontWeight.semibold, color: colors.text },
  stage: { flexShrink: 0, maxWidth: '55%', paddingVertical: 1, paddingHorizontal: 7, borderRadius: 6 },
  stageText: { fontSize: 10.5, fontWeight: fontWeight.semibold },
  meta: { fontSize: 12, color: colors.textMuted },
  latestRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  latest: { flexShrink: 1, fontSize: 12, color: colors.text },
  latestWarn: { color: colors.warning, fontWeight: fontWeight.semibold },
  latestVoice: { color: colors.primary, fontWeight: fontWeight.semibold },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3 },
  badge: {
    fontSize: 10.5,
    fontWeight: fontWeight.semibold,
    paddingVertical: 1,
    paddingHorizontal: 6,
    borderRadius: 6,
    overflow: 'hidden',
  },
  right: { alignItems: 'flex-end', gap: 6, flexShrink: 0 },
  when: {
    fontSize: 11,
    fontWeight: fontWeight.semibold,
    paddingVertical: 2,
    paddingHorizontal: 7,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: md.surface1,
    color: colors.textMuted,
  },
  whenLate: { backgroundColor: md.errorC, color: md.onErrorC },
  actions: { flexDirection: 'row', gap: 4 },
  round: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
