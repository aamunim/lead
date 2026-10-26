import { useEffect, useState } from 'react';

import type { StageInfo } from '@/features/activity/api';
import { listAssignableUsers } from '@/features/leads/api';
import { listPipelineStages } from '@/features/pipeline/api';

/** Stage names and people's names for the change lines (switched-off ones too) */
export function useActivityLookups() {
  const [stages, setStages] = useState<Map<string, StageInfo>>(new Map());
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [userNames, setUserNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    listPipelineStages(true)
      .then((s) => setStages(new Map(s.map((x) => [x.id, { name: x.name, kind: x.kind }]))))
      .catch(() => undefined);
    listAssignableUsers({ includeInactive: true })
      .then((u) => {
        setPeople(u.filter((p) => p.is_active).map((p) => ({ id: p.id, name: p.full_name ?? 'No name' })));
        setUserNames(new Map(u.map((p) => [p.id, p.full_name ?? 'No name'])));
      })
      .catch(() => undefined);
  }, []);

  return { stages, people, userNames };
}
