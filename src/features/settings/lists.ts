import type { ListTable } from './api';

// ---------------------------------------------------------------------
// Field types the generic list editor knows how to show
// ---------------------------------------------------------------------
export type FieldConfig =
  | { key: string; label: string; type: 'text'; required?: boolean; placeholder?: string }
  | { key: string; label: string; type: 'number'; placeholder?: string }
  | { key: string; label: string; type: 'date' }
  | { key: string; label: string; type: 'color' }
  | { key: string; label: string; type: 'boolean'; hint?: string }
  | {
      key: string;
      label: string;
      type: 'reference';
      table: 'lead_sources' | 'courses';
      emptyLabel: string; // label for "no selection"
    }
  | {
      key: string;
      label: string;
      type: 'choice';
      options: { value: string; label: string }[];
    };

export type ListConfig = {
  table: ListTable;
  title: string;        // shown on the settings hub and the screen header
  singular: string;     // e.g. "source" → "Add source"
  description: string;  // one line on the hub tile
  icon: string;         // emoji for now; real icons later
  group: 'leads' | 'admissions';
  fields: FieldConfig[]; // extra fields besides name
  systemKey?: boolean;  // rows have a fixed "key" and an is_system flag
};

// Colours offered for tags and stages
export const COLOR_CHOICES = [
  '#3557D4', '#4B3FC4', '#6334B8', '#C2366B', '#B23A0B',
  '#E0901C', '#8A5300', '#1F6B42', '#1D8BA6', '#5B6478',
];

// ---------------------------------------------------------------------
// The lists
// ---------------------------------------------------------------------
export const LIST_CONFIGS: Record<ListTable, ListConfig> = {
  lead_sources: {
    table: 'lead_sources',
    title: 'Lead sources',
    singular: 'source',
    description: 'Where leads come from',
    icon: '🎯',
    group: 'leads',
    fields: [],
  },
  campaigns: {
    table: 'campaigns',
    title: 'Campaigns',
    singular: 'campaign',
    description: 'Ads, seminars and their cost',
    icon: '📣',
    group: 'leads',
    fields: [
      { key: 'source_id', label: 'Source', type: 'reference', table: 'lead_sources', emptyLabel: 'No source' },
      { key: 'cost', label: 'Cost (BDT)', type: 'number', placeholder: 'e.g. 15000' },
      { key: 'start_date', label: 'Start date', type: 'date' },
      { key: 'end_date', label: 'End date', type: 'date' },
    ],
  },
  pipeline_stages: {
    table: 'pipeline_stages',
    title: 'Pipeline stages',
    singular: 'stage',
    description: 'Steps from new lead to admission',
    icon: '🪜',
    group: 'leads',
    systemKey: true,
    fields: [{ key: 'color', label: 'Colour', type: 'color' }],
  },
  lost_reasons: {
    table: 'lost_reasons',
    title: 'Lost reasons',
    singular: 'reason',
    description: 'Why leads do not join',
    icon: '📉',
    group: 'leads',
    fields: [],
  },
  call_results: {
    table: 'call_results',
    title: 'Call results',
    singular: 'result',
    description: 'Outcomes a caller can pick',
    icon: '📞',
    group: 'leads',
    systemKey: true,
    fields: [
      { key: 'is_connected', label: 'Lead was reached', type: 'boolean', hint: 'Counts as a real conversation' },
      { key: 'requires_note', label: 'Note required', type: 'boolean', hint: 'Caller must write what was discussed' },
    ],
  },
  tags: {
    table: 'tags',
    title: 'Tags',
    singular: 'tag',
    description: 'Labels like Scholarship or VIP',
    icon: '🏷️',
    group: 'leads',
    fields: [{ key: 'color', label: 'Colour', type: 'color' }],
  },
  lead_types: {
    table: 'lead_types',
    title: 'Lead types',
    singular: 'lead type',
    description: 'Student, guardian, agent…',
    icon: '👤',
    group: 'leads',
    fields: [],
  },
  document_types: {
    table: 'document_types',
    title: 'Paper types',
    singular: 'paper type',
    description: 'Documents needed for admission',
    icon: '📄',
    group: 'admissions',
    fields: [
      { key: 'course_id', label: 'Course', type: 'reference', table: 'courses', emptyLabel: 'All courses' },
      { key: 'is_required', label: 'Required', type: 'boolean', hint: 'Must be received before admission' },
    ],
  },
};

export function getListConfig(table: string): ListConfig | null {
  return (LIST_CONFIGS as Record<string, ListConfig>)[table] ?? null;
}