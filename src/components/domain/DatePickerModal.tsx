/**
 * 格物 · 日期选择器
 *
 * 自绘月历，不引第三方日期组件：一是少一个依赖，二是能和暖棕纸感
 * 的设计语言完全对齐（原生选择器在 Android 上是另一套观感）。
 *
 * 两级粒度跳转（日 → 月 → 年）：买三年前的东西不该点三十多次箭头。
 * 面板高度锁定为常量，三档视图共用 —— 换月时不再上下伸缩。
 */

import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { GUTTER, Palette, Radius, Space, Type } from '@/constants/theme';
import { formatDateCN, parseDate, today, toDateString } from '@/lib/date';
import { Button } from '../ui/controls';
import { Divider } from '../ui/layout';
import { Body, Heading, Label, Meta } from '../ui/typography';
import { makeStyles } from '@/lib/theme';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS = Array.from({ length: 12 }, (_, i) => `${i + 1} 月`);

/* ------------------------------------------------------------ 尺寸常量
 * 三档视图（日 / 月 / 年）共用同一个面板高度，切换粒度、前后翻月
 * 都不会让弹层上下抽动。改这几个数请保持彼此自洽：
 *   PANE_H = WEEK_H + DAY_CELL_H * DAY_ROWS = OPT_CELL_H * OPT_ROWS
 */
const DAY_ROWS = 6;
const DAY_CELL_H = 46;
const WEEK_H = 24;
const PANE_H = WEEK_H + DAY_CELL_H * DAY_ROWS; // 300
const OPT_ROWS = 3;
const OPT_CELL_H = PANE_H / OPT_ROWS; // 100
const YEARS_PER_PAGE = 12;

type Level = 'day' | 'month' | 'year';

export interface DatePickerModalProps {
  visible: boolean;
  /** 当前值，`YYYY-MM-DD` */
  value: string | null;
  onClose: () => void;
  onPick: (date: string | null) => void;
  title?: string;
  /** 是否允许清除（购买日期通常允许，过期时间也允许） */
  clearable?: boolean;
}

/**
 * 生成某月的 6×7 网格，null 表示补位。
 * 恒定 6 行是刻意的：按实际周数补位会出现 5 行 / 6 行交替，
 * 弹层高度随之变化，连点箭头时整块 UI 来回跳。
 */
function monthMatrix(year: number, month: number): (number | null)[] {
  const lead = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length < DAY_ROWS * 7) cells.push(null);
  return cells;
}

export function DatePickerModal({
  visible,
  value,
  onClose,
  onPick,
  title = '选择日期',
  clearable = true,
}: DatePickerModalProps) {
  const styles = useStyles();
  const initial = useMemo(() => parseDate(value) ?? new Date(), [value]);
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth());
  const [level, setLevel] = useState<Level>('day');

  // 每次打开都回到当前值的月份，避免残留上次浏览的位置
  useEffect(() => {
    if (!visible) return;
    const d = parseDate(value) ?? new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setLevel('day');
  }, [visible, value]);

  const cells = useMemo(() => monthMatrix(year, month), [year, month]);
  const selected = value ?? '';
  const todayStr = today();
  const todayDate = parseDate(todayStr);

  /** 翻页步档：日视图翻月、月视图翻年、年视图翻页（12 年） */
  const shift = (delta: number) => {
    if (level === 'year') {
      setYear((y) => y + delta * YEARS_PER_PAGE);
      return;
    }
    const step = level === 'month' ? delta * 12 : delta;
    const next = new Date(year, month + step, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth());
  };

  const yearPageStart = Math.floor(year / YEARS_PER_PAGE) * YEARS_PER_PAGE;
  const yearPageEnd = yearPageStart + YEARS_PER_PAGE - 1;

  const pageLabel =
    level === 'year' ? `${yearPageStart} – ${yearPageEnd}` : `${year} 年`;

  const pick = (dateStr: string) => {
    onPick(dateStr);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Heading>{title}</Heading>
          <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onClose} hitSlop={10}>
            <Ionicons name="close" size={20} color={Palette.ink3} />
          </Pressable>
        </View>

        <View style={styles.bar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={level === 'year' ? '前 12 年' : level === 'month' ? '上一年' : '上个月'}
            onPress={() => shift(-1)}
            hitSlop={10}
            style={styles.barNav}>
            <Ionicons name="chevron-back" size={18} color={Palette.ink2} />
          </Pressable>

          {level === 'year' ? (
            <Body style={styles.barLabel}>{pageLabel}</Body>
          ) : (
            /* 点标题往下钻一层粒度：先挑年、再挑月，最后回到日 */
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={level === 'day' ? '选择年与月' : '选择年份'}
              onPress={() => setLevel(level === 'day' ? 'month' : 'year')}
              hitSlop={8}
              style={styles.barLabelBtn}>
              <Body style={styles.barLabel}>
                {level === 'day' ? `${year} 年 ${month + 1} 月` : pageLabel}
              </Body>
              <Ionicons name="caret-down" size={11} color={Palette.ink4} style={styles.barCaret} />
            </Pressable>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={level === 'year' ? '后 12 年' : level === 'month' ? '下一年' : '下个月'}
            onPress={() => shift(1)}
            hitSlop={10}
            style={styles.barNav}>
            <Ionicons name="chevron-forward" size={18} color={Palette.ink2} />
          </Pressable>
        </View>

        {/* 固定高度的面板：三档视图共用 */}
        <View style={styles.pane}>
          {level === 'day' ? (
            <>
              <View style={styles.weekRow}>
                {WEEKDAYS.map((w) => (
                  <Label key={w} tone="ink4" style={styles.weekCell}>
                    {w}
                  </Label>
                ))}
              </View>
              <View style={styles.grid}>
                {cells.map((day, i) => {
                  if (day == null) return <View key={`pad-${i}`} style={styles.cell} />;
                  const dateStr = toDateString(new Date(year, month, day));
                  const isSelected = dateStr === selected;
                  const isToday = dateStr === todayStr;
                  return (
                    <Pressable
                      key={dateStr}
                      accessibilityRole="button"
                      accessibilityLabel={formatDateCN(dateStr)}
                      accessibilityState={{ selected: isSelected }}
                      onPress={() => pick(dateStr)}
                      style={styles.cell}>
                      <View
                        style={[
                          styles.day,
                          isSelected && styles.daySelected,
                          !isSelected && isToday && styles.dayToday,
                        ]}>
                        <Body
                          color={isSelected ? Palette.onAccent : isToday ? Palette.brand : Palette.ink}
                          style={styles.dayText}>
                          {day}
                        </Body>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          {level === 'month' ? (
            <View style={styles.optGrid}>
              {MONTHS.map((label, i) => {
                const isSelected = i === month;
                const isToday =
                  !!todayDate && year === todayDate.getFullYear() && i === todayDate.getMonth();
                return (
                  <Pressable
                    key={label}
                    accessibilityRole="button"
                    accessibilityLabel={`${year} 年 ${i + 1} 月`}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => {
                      setMonth(i);
                      setLevel('day');
                    }}
                    style={styles.optCell}>
                    <View
                      style={[
                        styles.optChip,
                        isSelected && styles.optChipSelected,
                        !isSelected && isToday && styles.optChipToday,
                      ]}>
                      <Body
                        color={isSelected ? Palette.onAccent : isToday ? Palette.brand : Palette.ink}
                        style={styles.optText}>
                        {label}
                      </Body>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {level === 'year' ? (
            <View style={styles.optGrid}>
              {Array.from({ length: YEARS_PER_PAGE }, (_, i) => yearPageStart + i).map((y) => {
                const isSelected = y === year;
                const isToday = !!todayDate && y === todayDate.getFullYear();
                return (
                  <Pressable
                    key={y}
                    accessibilityRole="button"
                    accessibilityLabel={`${y} 年`}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => {
                      setYear(y);
                      setLevel('month');
                    }}
                    style={styles.optCell}>
                    <View
                      style={[
                        styles.optChip,
                        isSelected && styles.optChipSelected,
                        !isSelected && isToday && styles.optChipToday,
                      ]}>
                      <Body
                        color={isSelected ? Palette.onAccent : isToday ? Palette.brand : Palette.ink}
                        style={styles.optText}>
                        {y}
                      </Body>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>

        <Divider style={styles.divider} />

        <View style={styles.foot}>
          <Meta tone="ink3">当前：{value ? formatDateCN(value) : '未设置'}</Meta>
          <View style={styles.footActions}>
            {clearable ? (
              <Button
                label="清除"
                tone="ghost"
                block={false}
                onPress={() => {
                  onPick(null);
                  onClose();
                }}
              />
            ) : null}
            <Button label="今天" tone="secondary" block={false} onPress={() => pick(todayStr)} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((Palette) => ({
  backdrop: { flex: 1, backgroundColor: Palette.scrim },
  sheet: {
    backgroundColor: Palette.surface,
    borderTopLeftRadius: Radius.sheet,
    borderTopRightRadius: Radius.sheet,
    paddingBottom: Space.xxl,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Palette.line,
    alignSelf: 'center',
    marginTop: Space.sm,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingTop: Space.lg,
    paddingBottom: Space.sm,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingVertical: Space.sm,
  },
  barNav: { padding: Space.xs },
  barLabelBtn: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  barLabel: { fontWeight: '600' },
  barCaret: { marginTop: 2 },
  /* 固定高度容器：日 / 月 / 年三档视图等高，切换与翻页都不跳 */
  pane: { height: PANE_H },
  weekRow: { height: WEEK_H, flexDirection: 'row', paddingHorizontal: GUTTER - Space.xs },
  weekCell: { flex: 1, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: GUTTER - Space.xs },
  cell: { width: `${100 / 7}%`, height: DAY_CELL_H, alignItems: 'center', justifyContent: 'center' },
  day: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: Palette.brand },
  dayToday: { borderWidth: StyleSheet.hairlineWidth, borderColor: Palette.brand },
  dayText: { fontSize: 14 },
  optGrid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: GUTTER - Space.xs,
  },
  optCell: {
    width: '25%',
    height: OPT_CELL_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optChip: {
    minWidth: 62,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    borderRadius: Radius.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optChipSelected: { backgroundColor: Palette.brand },
  optChipToday: { borderWidth: StyleSheet.hairlineWidth, borderColor: Palette.brand },
  optText: { fontSize: Type.body.fontSize, fontWeight: '500' },
  divider: { marginTop: Space.sm },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: GUTTER,
    paddingTop: Space.md,
  },
  footActions: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
}));
