import { useEffect, useRef, type ComponentRef, type RefObject } from 'react';
import {
  Platform,
  ScrollView,
  TextInput,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from 'react-native';
import { KeyboardEvents } from 'react-native-keyboard-controller';

// =====================================================================
// ⌨️ The scroll area inside a bottom sheet with text fields.
//   The sheet's Modal (keyboard prop) lifts the sheet above the keyboard
//   and makes it shorter. A field low in a long sheet can then sit
//   below the part you can see. When the keyboard has opened, this
//   scrolls the field you type in into view. It only scrolls when the
//   field is hidden, and only for a field inside this sheet.
// =====================================================================

const GAP = 16;

type ScrollRef = ComponentRef<typeof ScrollView>;

export function SheetScroll({ onScroll, onContentSizeChange, scrollEventThrottle, ...props }: ScrollViewProps) {
  const ref = useRef<ScrollRef>(null);
  const top = useRef(0);
  const open = useRef(false);
  const frame = useRef(0);

  // after the sheet has its new size: bring the field you type in into view
  const check = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => showFocused(ref, top));
  };

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const shown = KeyboardEvents.addListener('keyboardDidShow', () => {
      open.current = true;
      check();
    });
    const hidden = KeyboardEvents.addListener('keyboardDidHide', () => {
      open.current = false;
    });
    return () => {
      cancelAnimationFrame(frame.current);
      shown.remove();
      hidden.remove();
    };
  }, []);

  return (
    <ScrollView
      ref={ref}
      keyboardShouldPersistTaps="handled"
      {...props}
      scrollEventThrottle={scrollEventThrottle ?? 16}
      onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
        top.current = e.nativeEvent.contentOffset.y;
        onScroll?.(e);
      }}
      onContentSizeChange={(w, h) => {
        // a note growing line by line while you type (iPhone does not follow it)
        if (open.current) check();
        onContentSizeChange?.(w, h);
      }}
    />
  );
}

function showFocused(ref: RefObject<ScrollRef | null>, top: RefObject<number>) {
  const sv = ref.current;
  const input = TextInput.State.currentlyFocusedInput();
  const inner = sv?.getInnerViewRef();
  if (!sv || !input || !inner) return;
  // the sheet's height right now (it changes while the keyboard opens)
  sv.measure((_x, _y, _w, view) => {
    if (!view) return;
    // y of the field inside this sheet's content; fails (and we do nothing)
    // when the field is not inside this sheet
    input.measureLayout(
      inner,
      (_x2, y, _w2, h) => {
        const seen = top.current;
        if (y + h + GAP > seen + view) {
          // below what you see: bring its bottom up (a tall field: its top)
          sv.scrollTo({ y: Math.max(0, Math.min(y - GAP, y + h + GAP - view)), animated: true });
        } else if (y - GAP < seen) {
          sv.scrollTo({ y: Math.max(0, y - GAP), animated: true });
        }
      },
      () => {},
    );
  });
}

/**
 * For a text field that should get the keyboard when its sheet opens.
 * Use it instead of autoFocus in a sheet: pass onShow to the sheet's Modal
 * (or Sheet) and ref to the field. The keyboard then opens once the sheet
 * is on screen, so the sheet hears it and moves up above it (with
 * autoFocus the keyboard could open before that, and cover the sheet).
 */
export function useSheetFocus() {
  const ref = useRef<ComponentRef<typeof TextInput>>(null);
  const done = useRef(false);
  const focus = () => {
    if (done.current) return;
    done.current = true;
    ref.current?.focus();
  };
  useEffect(() => {
    // in case the Modal's onShow never comes (web, or an old phone)
    const t = setTimeout(focus, Platform.OS === 'web' ? 0 : 1000);
    return () => clearTimeout(t);
  }, []);
  return { ref, onShow: focus };
}
