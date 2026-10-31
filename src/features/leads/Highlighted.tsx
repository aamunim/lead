import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { findDigits, findText } from '@/features/leads/search';
import { colors, fontWeight } from '@/shared/theme';

/** One line of text with the searched part marked (words, or digits in a number) */
export function Highlighted({ text, search, style }: { text: string; search: string; style: StyleProp<TextStyle> }) {
  const s = search.trim();
  const range = s ? (findText(text, s) ?? findDigits(text, s)) : null;
  if (!range) {
    return (
      <Text style={style} numberOfLines={1}>
        {text}
      </Text>
    );
  }
  const [from, to] = range;
  return (
    <Text style={style} numberOfLines={1}>
      {text.slice(0, from)}
      <Text style={styles.hit}>{text.slice(from, to)}</Text>
      {text.slice(to)}
    </Text>
  );
}

const styles = StyleSheet.create({
  hit: { fontWeight: fontWeight.bold, color: colors.text, backgroundColor: '#FEF08A' },
});
