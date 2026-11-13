import { forwardRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { bdPhoneProblem, toEnglishDigits } from '@/shared/lib/phone';
import { colors, fontSize, fontWeight, radius, spacing } from '@/shared/theme';

type TextFieldProps = TextInputProps & {
  label: string;
  error?: string | null;
  hint?: string;
  required?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  /** 📞 a student's number: a soft note when it is not a Bangladesh mobile (gets no SMS) */
  smsCheck?: boolean;
};

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  {
    label,
    error,
    hint,
    required = false,
    containerStyle,
    smsCheck = false,
    secureTextEntry,
    editable = true,
    onFocus,
    onBlur,
    onChangeText,
    keyboardType,
    value,
    ...rest
  },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);

  const isPassword = !!secureTextEntry;
  const hasError = !!error;
  // 📞 a phone box: Bangla digits become 0-9 as you type; after leaving the box,
  //    a soft note when it is not a Bangladesh mobile number (saving still works)
  const isPhone = keyboardType === 'phone-pad';
  const phoneNote =
    smsCheck && !focused && typeof value === 'string' && value.replace(/\D/g, '').length >= 5
      ? bdPhoneProblem(value)
      : null;

  return (
    <View style={[styles.container, containerStyle]}>
      <Text style={styles.label}>
        {label}
        {required && <Text style={styles.required}> *</Text>}
      </Text>

      <View
        style={[
          styles.inputWrap,
          focused && styles.inputFocused,
          hasError && styles.inputError,
          !editable && styles.inputDisabled,
        ]}
      >
        <TextInput
          ref={ref}
          style={styles.input}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={isPassword && hidden}
          editable={editable}
          accessibilityLabel={label}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          keyboardType={keyboardType}
          value={value}
          onChangeText={isPhone && onChangeText ? (t) => onChangeText(toEnglishDigits(t)) : onChangeText}
          {...rest}
        />

        {isPassword && (
          <Pressable
            onPress={() => setHidden((h) => !h)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={hidden ? 'Show password' : 'Hide password'}
          >
            <Text style={styles.toggle}>{hidden ? 'Show' : 'Hide'}</Text>
          </Pressable>
        )}
      </View>

      {hasError ? (
        <Text style={styles.error}>{error}</Text>
      ) : phoneNote ? (
        <Text style={styles.warn}>⚠️ {phoneNote} — no SMS to this number</Text>
      ) : hint ? (
        <Text style={styles.hint}>{hint}</Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  label: {
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  required: {
    color: colors.danger,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  inputFocused: {
    borderColor: colors.primary,
  },
  inputError: {
    borderColor: colors.danger,
  },
  inputDisabled: {
    backgroundColor: colors.background,
  },
  input: {
    flex: 1,
    paddingVertical: spacing.sm,
    fontSize: fontSize.body,
    color: colors.text,
  },
  toggle: {
    marginLeft: spacing.sm,
    fontSize: fontSize.small,
    fontWeight: fontWeight.semibold,
    color: colors.primary,
  },
  error: {
    fontSize: fontSize.caption,
    color: colors.danger,
  },
  hint: {
    fontSize: fontSize.caption,
    color: colors.textMuted,
  },
  warn: {
    fontSize: fontSize.caption,
    color: colors.warning,
  },
});
