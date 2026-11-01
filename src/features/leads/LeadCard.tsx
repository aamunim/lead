import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { feeBadge } from '@/features/fees/api';
import type { LeadListItem } from '@/features/leads/api';
import { contactLabel, whatsAppOnly } from '@/features/leads/contact';
import { Highlighted } from '@/features/leads/Highlighted';
import { ago, callDot, callLineText, daysSince } from '@/features/leads/lastActivity';
import { otherMatch } from '@/features/leads/search';
import { papersBadge } from '@/features/papers/api';
import type { TemplateChannel } from '@/features/templates/api';
import { visitBadge } from '@/features/visits/api';
import { clock } from '@/features/voice/format';
import { isWeb } from '@/features/web/api';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';
import { approvalBadge } from '@/features/approval/api';

// =====================================================================
// 🗂 One lead's card: the Leads / Students list and the pipeline board
//   Tap = open · long press = mark (several at once) · Call / WhatsApp /
//   SMS on the right · last call and last note (Detailed) · 👁 peek
// =====================================================================

const RATING_COLOR: Record<string, string> = {
  hot: colors.hot,
  warm: colors.warm,
  cold: colors.cold,
};

const WHATSAPP_GREEN = '#25D366';

// Closed leads on the card
const CLOSED_BADGE: Record<string, { label: string; color: string }> = {
  won: { label: '🎓 Admitted', color: colors.success },
  lost: { label: '✕ Lost', color: colors.danger },
  cancelled: { label: '↩ Cancelled', color: colors.textMuted },
};

function followUpLabel(iso: string | null): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const date = new Date(iso);
  const now = new Date();
  const overdue = date.getTime() < now.getTime();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return { text: `Today ${time}`, overdue };
  return {
    text: date.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ` ${time}`,
    overdue,
  };
}

export function LeadCard({
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
}: {
  lead: LeadListItem;
  /** 🔍 The search: its match is highlighted, or shown under the name */
  search?: string;
  /** 📞📝 Show the last call and last note lines */
  detailed?: boolean;
  /** Open leads without contact for this many days turn orange (0 = off) */
  staleDays?: number;
  nameOf?: (id: string | null) => string | null;
  /** Tap on the last call / note: the last few, without opening the lead */
  onPeek?: () => void;
  onPlayVoice?: (fileId: string, seconds: number | null) => void;
  /** On the Students list: student ID, course · batch, no "Admitted" badge */
  student?: boolean;
  showAssignee: boolean;
  selecting: boolean;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onCall: () => void;
  onWhatsApp: () => void;
  onSms: () => void;
  /** Long press on WhatsApp / SMS: pick a message template */
  onTemplate?: (channel: TemplateChannel) => void;
}) {
  const ratingColor = lead.rating ? RATING_COLOR[lead.rating] : null;
  const courses = lead.lead_courses.map((c) => c.course?.name).filter(Boolean).join(', ');
  const followUp = followUpLabel(lead.next_follow_up_at);

  // Admitted / Lost / Cancelled
  const kind = lead.stage?.kind ?? 'open';
  const closed = kind !== 'open' && !student ? CLOSED_BADGE[kind] : null;
  const faded = kind === 'lost' || kind === 'cancelled';

  const admittedTo =
    kind === 'won' && lead.admitted_course
      ? [lead.admitted_course.name, lead.admitted_batch?.name].filter(Boolean).join(' · ')
      : null;
  const metaParts = (
    student
      ? [
          lead.student_ref ? `🪪 ${lead.student_ref}` : null,
          lead.nu_admission_id ? `NU ${lead.nu_admission_id}` : null,
          admittedTo ?? courses,
          lead.phone,
        ]
      : [whatsAppOnly(lead) ? `💬 ${contactLabel(lead)}` : lead.phone, kind === 'won' ? lead.student_ref : null, admittedTo ?? courses]
  ).filter(Boolean);

  const matchLine = search ? otherMatch(lead, search) : null;

  // 📞📝 Last call and last note (open leads also: ⏳ no contact for a while)
  const last = lead.last;
  const callText = detailed && last ? callLineText(last, nameOf) : null;
  const since = daysSince(lead.last_contacted_at);
  const stale =
    detailed && kind === 'open' && staleDays > 0 && (since === null ? !last?.call_at : since >= staleDays);
  const staleText = !stale ? null : since === null ? '🆕 Not called yet' : `⏳ No contact for ${since} days`;
  const noteVoice = last?.note_kind === 'voice' && !!last.note_voice_file;
  const noteText = detailed && last?.note_at ? (noteVoice ? null : last.note_text) : null;

  // 📄 3/5: open leads and admitted students (not lost / cancelled)
  const papers =
    kind === 'open' || kind === 'won'
      ? papersBadge(lead.papers_required ?? 0, (lead.papers_required ?? 0) - (lead.papers_missing ?? 0))
      : null;

  // 🏫 Today 11:00 AM / Visited: open leads only
  const visit = kind === 'open' ? visitBadge(lead.visit_status, lead.visit_at) : null;
  const visitSoon = lead.visit_status === 'planned';
  const visitLate = visitSoon && !!lead.visit_at && new Date(lead.visit_at).getTime() < Date.now();

  // 💰 Negotiating / ⏳ Discount / 💰 −৳3,500
  const fee = kind === 'open' || kind === 'won' ? feeBadge(lead) : null;
  const approval = student && kind === 'won' ? approvalBadge(lead.approval_status) : null;
  const approvalColor =
    approval?.color === 'good' ? colors.success : approval?.color === 'bad' ? colors.danger : colors.warning;

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.card,
        ratingColor && { borderLeftColor: ratingColor, borderLeftWidth: 4 },
        kind === 'won' && styles.cardWon,
        faded && styles.cardFaded,
        selected && styles.cardSelected,
        pressed && styles.cardPressed,
      ]}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={`${lead.name}, ${lead.stage?.name ?? ''}`}
    >
      {selecting && (
        <View style={[styles.check, selected && styles.checkOn]}>
          {selected && <Ionicons name="checkmark" size={16} color={colors.textOnPrimary} />}
        </View>
      )}

      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Highlighted text={lead.name} search={search} style={styles.name} />
          {lead.rating && ratingColor && (
            <Text style={[styles.rating, { color: ratingColor, borderColor: ratingColor }]}>
              {lead.rating.toUpperCase()}
            </Text>
          )}
        </View>

        <Highlighted text={metaParts.join(' · ')} search={search} style={styles.meta} />
        {/* 🔍 Found in a field the card doesn't show (guardian, email, area…) */}
        {!!matchLine && (
          <Text style={styles.matchLine} numberOfLines={1}>
            🔍 {matchLine}
          </Text>
        )}

        {/* 📞 Last call (or ⏳ no contact for a while) */}
        {(!!callText || !!staleText) && (
          <Pressable onPress={onPeek} hitSlop={4} style={styles.lastRow} accessibilityRole="button" accessibilityHint="Shows the last calls and notes">
            {!!callText && <View style={[styles.lastDot, { backgroundColor: callDot(last?.call_outcome ?? null) }]} />}
            <Text style={[styles.lastText, !!staleText && styles.lastStale]} numberOfLines={1}>
              {[callText, staleText].filter(Boolean).join(' · ')}
            </Text>
          </Pressable>
        )}

        {/* 📝 Last note (one line; the whole of it in the peek) or 🎙 a voice note */}
        {detailed && noteVoice && last && (
          <Pressable
            onPress={() => onPlayVoice?.(last.note_voice_file as string, last.note_voice_sec)}
            hitSlop={4}
            style={styles.lastRow}
            accessibilityRole="button"
            accessibilityLabel="Play the last voice note"
          >
            <Text style={styles.lastVoice} numberOfLines={1}>
              🎙 Voice note{last.note_voice_sec ? ` · ${clock(last.note_voice_sec)}` : ''} ▶
              <Text style={styles.lastMuted}>{last.note_at ? ` · ${ago(last.note_at)}` : ''}</Text>
            </Text>
          </Pressable>
        )}
        {!!noteText && last && (
          <Pressable onPress={onPeek} hitSlop={4} style={styles.lastRow} accessibilityRole="button" accessibilityHint="Shows the whole note">
            <Text style={styles.lastNote} numberOfLines={1}>
              📝 “{noteText}{last.note_more ? '…' : ''}”
              <Text style={styles.lastMuted}>{last.note_at ? ` · ${ago(last.note_at)}` : ''}</Text>
            </Text>
          </Pressable>
        )}

        <View style={styles.cardBottom}>
          {student ? (
            // 🎓 Admission approval: ⏳ waiting / ✅ approved / ↩ sent back
            approval && (
              <View style={[styles.stage, { backgroundColor: approvalColor + '1F' }]}>
                <Text style={[styles.stageText, { color: approvalColor }]}>{approval.text}</Text>
              </View>
            )
          ) : closed ? (
            <View style={[styles.stage, { backgroundColor: closed.color + '1F' }]}>
              <Text style={[styles.stageText, { color: closed.color }]}>{closed.label}</Text>
            </View>
          ) : (
            lead.stage && (
              <View style={[styles.stage, { backgroundColor: lead.stage.color + '22' }]}>
                <Text style={[styles.stageText, { color: lead.stage.color }]}>{lead.stage.name}</Text>
              </View>
            )
          )}
          {papers && (
            <View style={[styles.papers, papers.complete ? styles.papersDone : styles.papersMissing]}>
              <Text style={[styles.papersText, { color: papers.complete ? colors.success : colors.warning }]}>
                {papers.text}
              </Text>
            </View>
          )}
          {visit && (
            <View style={[styles.papers, visitSoon ? styles.visitPlanned : styles.visitOther]}>
              <Text
                style={[
                  styles.papersText,
                  { color: visitLate ? colors.danger : visitSoon ? colors.primary : colors.textMuted },
                ]}
              >
                {visit}
              </Text>
            </View>
          )}
          {fee && (
            <View
              style={[
                styles.papers,
                fee.tone === 'wait' || fee.tone === 'bad'
                  ? styles.papersMissing
                  : fee.tone === 'good'
                    ? styles.papersDone
                    : styles.visitOther,
              ]}
            >
              <Text
                style={[
                  styles.papersText,
                  {
                    color:
                      fee.tone === 'bad'
                        ? colors.danger
                        : fee.tone === 'wait'
                          ? colors.warning
                          : fee.tone === 'good'
                            ? colors.success
                            : colors.text,
                  },
                ]}
              >
                {fee.text}
              </Text>
            </View>
          )}
          {followUp && (
            <Text style={[styles.followUp, followUp.overdue && styles.overdue]}>
              {followUp.overdue ? '⚠ ' : '🗓 '}
              {followUp.text}
            </Text>
          )}
          {showAssignee && (
            <Text style={styles.assignee} numberOfLines={1}>
              {lead.assignee?.full_name ?? 'Unassigned'}
            </Text>
          )}
        </View>
      </View>

      {!selecting && (
        <View style={styles.contact}>
          {/* 🌐 No phone calls from a computer */}
          {!!lead.phone && !isWeb && (
            <ContactButton icon="call" color={colors.success} label={`Call ${lead.name}`} onPress={onCall} />
          )}
          <ContactButton
            icon="logo-whatsapp"
            color={WHATSAPP_GREEN}
            label={`WhatsApp ${lead.name}`}
            onPress={onWhatsApp}
            onLongPress={onTemplate && (() => onTemplate('whatsapp'))}
          />
          {!!lead.phone && !isWeb && (
            <ContactButton
              icon="chatbubble-ellipses"
              color={colors.info}
              label={`SMS ${lead.name}`}
              onPress={onSms}
              onLongPress={onTemplate && (() => onTemplate('sms'))}
            />
          )}
        </View>
      )}
    </Pressable>
  );
}

function ContactButton({
  icon,
  color,
  label,
  onPress,
  onLongPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
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
      style={({ pressed }) => [styles.contactBtn, { backgroundColor: color + '1A' }, pressed && styles.contactPressed]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={17} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  assignee: { fontSize: 11, color: colors.textMuted },
  cardBody: { flex: 1, gap: 4 },
  cardBottom: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  cardFaded: { opacity: 0.7 },
  cardPressed: { opacity: 0.7 },
  cardSelected: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.primarySoft, opacity: 1 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardWon: { backgroundColor: colors.successSoft },
  check: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  contact: { flexDirection: 'row', gap: 6 },
  contactBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactPressed: { opacity: 0.6, transform: [{ scale: 0.92 }] },
  followUp: { fontSize: 11, color: colors.textMuted },
  lastDot: { width: 7, height: 7, borderRadius: 4 },
  lastMuted: { fontStyle: 'normal', fontWeight: fontWeight.regular, color: colors.textMuted },
  lastNote: { flexShrink: 1, fontSize: fontSize.caption, color: colors.text, fontStyle: 'italic' },
  lastRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  lastStale: { color: colors.warning, fontWeight: fontWeight.semibold },
  lastText: { flexShrink: 1, fontSize: fontSize.caption, color: colors.textMuted },
  lastVoice: { flexShrink: 1, fontSize: fontSize.caption, fontWeight: fontWeight.semibold, color: colors.primary },
  matchLine: { fontSize: fontSize.caption, color: colors.textMuted, marginTop: 2 },
  meta: { fontSize: fontSize.caption, color: colors.textMuted },
  name: { flexShrink: 1, fontSize: fontSize.body, fontWeight: fontWeight.semibold, color: colors.text },
  overdue: { color: colors.danger, fontWeight: fontWeight.bold },
  papers: { paddingVertical: 1, paddingHorizontal: 6, borderRadius: radius.pill, borderWidth: 1 },
  papersDone: { borderColor: colors.success, backgroundColor: colors.successSoft },
  papersMissing: { borderColor: colors.warning, backgroundColor: colors.surface },
  papersText: { fontSize: 11, fontWeight: fontWeight.bold },
  rating: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
    paddingVertical: 1,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  stage: { paddingVertical: 2, paddingHorizontal: spacing.sm, borderRadius: radius.pill },
  stageText: { fontSize: 11, fontWeight: fontWeight.bold },
  visitOther: { borderColor: colors.border, backgroundColor: colors.surface },
  visitPlanned: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
});
