export interface RequiredAutopilotInvariant {
  name: string;
  isPresent: (content: string) => boolean;
  message: string;
}

export interface AutopilotInvariantCheck {
  filePath: string;
  name: string;
  ok: boolean;
  message: string;
}

const CONFLICT_MARKER_PATTERN = /^<<<<<<<|^=======|^>>>>>>>|^\|\|\|\|\|\|\|/m;

const SUPABASE_TENANT_TABLES = [
  'collections',
  'collection_fields',
  'collection_items',
  'collection_item_values',
  'components',
  'locales',
  'page_folders',
  'page_layers',
  'pages',
];

const TENANT_SCOPE_TOKENS = [
  'applyTenantEq',
  ".eq('tenant_id'",
  '.eq("tenant_id"',
  "where('tenant_id'",
  '.where("tenant_id"',
  "andWhere('tenant_id'",
  '.andWhere("tenant_id"',
  'tenant_id:',
  'set_tenant_context',
];

export function hasConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_PATTERN.test(content);
}

function tableQueryPattern(table: string): RegExp {
  return new RegExp(`\\.from\\(\\s*['"]${table}['"]\\s*\\)`, 'g');
}

function hasTenantScopeToken(content: string): boolean {
  return TENANT_SCOPE_TOKENS.some((token) => content.includes(token));
}

export function hasUnscopedSupabaseTableAccess(content: string, table: string): boolean {
  const pattern = tableQueryPattern(table);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const start = Math.max(0, match.index - 500);
    const end = Math.min(content.length, match.index + 1100);
    const window = content.slice(start, end);
    if (!hasTenantScopeToken(window)) {
      return true;
    }
  }
  return false;
}

export function usesInvalidSupabaseAdminTenantArgument(content: string): boolean {
  return /getSupabaseAdmin\(\s*[^)\s][^)]*\)/.test(content);
}

function repositoryInvariants(filePath: string): RequiredAutopilotInvariant[] {
  return [
    {
      name: 'tenant resolver present',
      isPresent: (content) => content.includes('resolveEffectiveTenantId') || content.includes('getTenantIdFromHeaders'),
      message: `${filePath} must resolve the effective tenant before service-role or Knex data access.`,
    },
    {
      name: 'tenant filter present',
      isPresent: (content) => hasTenantScopeToken(content),
      message: `${filePath} must keep tenant_id filters, inserts, or explicit tenant context.`,
    },
    {
      name: 'no invalid admin client arguments',
      isPresent: (content) => !usesInvalidSupabaseAdminTenantArgument(content),
      message: `${filePath} must not call getSupabaseAdmin() with tenant arguments; tenant scope must be resolved and filtered separately.`,
    },
  ];
}

function publishInvariants(filePath: string): RequiredAutopilotInvariant[] {
  return [
    {
      name: 'publish tenant resolver present',
      isPresent: (content) => content.includes('resolveEffectiveTenantId') || content.includes('runWithEffectiveTenantId'),
      message: `${filePath} must keep explicit tenant resolution so one tenant cannot publish another tenant.`,
    },
    {
      name: 'publish tenant context wrapper present',
      isPresent: (content) => content.includes('runWithEffectiveTenantId'),
      message: `${filePath} must execute publish work inside the effective tenant context.`,
    },
  ];
}

function pageFetcherInvariants(filePath: string): RequiredAutopilotInvariant[] {
  return [
    {
      name: 'tenant resolver present',
      isPresent: (content) => content.includes('resolveEffectiveTenantId'),
      message: `${filePath} must preserve host/subdomain tenant resolution via resolveEffectiveTenantId().`,
    },
    {
      name: 'tenant filter helper present',
      isPresent: (content) => content.includes('applyTenantEq'),
      message: `${filePath} must apply tenant filters to Supabase reads that load pages, folders, layers, locales, components, and CMS data.`,
    },
    {
      name: 'page reads tenant scoped',
      isPresent: (content) => !hasUnscopedSupabaseTableAccess(content, 'pages'),
      message: `${filePath} must not read pages through the service-role client without applyTenantEq or an explicit tenant_id filter.`,
    },
    {
      name: 'page layer reads tenant scoped',
      isPresent: (content) => !hasUnscopedSupabaseTableAccess(content, 'page_layers'),
      message: `${filePath} must not read page_layers through the service-role client without applyTenantEq or an explicit tenant_id filter.`,
    },
    {
      name: 'collection field reads tenant scoped',
      isPresent: (content) => !hasUnscopedSupabaseTableAccess(content, 'collection_fields'),
      message: `${filePath} must not read collection_fields through the service-role client without applyTenantEq or an explicit tenant_id filter.`,
    },
    {
      name: 'collection item reads tenant scoped',
      isPresent: (content) => !hasUnscopedSupabaseTableAccess(content, 'collection_items'),
      message: `${filePath} must not read collection_items through the service-role client without applyTenantEq or an explicit tenant_id filter.`,
    },
    {
      name: 'collection value reads tenant scoped',
      isPresent: (content) => !hasUnscopedSupabaseTableAccess(content, 'collection_item_values'),
      message: `${filePath} must not read collection_item_values through the service-role client without applyTenantEq or an explicit tenant_id filter.`,
    },
    {
      name: 'no invalid admin client arguments',
      isPresent: (content) => !usesInvalidSupabaseAdminTenantArgument(content),
      message: `${filePath} must not call getSupabaseAdmin() with tenant arguments; tenant scope must be resolved and filtered separately.`,
    },
  ];
}

function collectionServiceInvariants(filePath: string): RequiredAutopilotInvariant[] {
  return [
    {
      name: 'tenant resolver present',
      isPresent: (content) => content.includes('resolveEffectiveTenantId') || content.includes('getTenantIdFromHeaders'),
      message: `${filePath} must resolve tenant context before service-role Supabase or Knex reads/writes.`,
    },
    {
      name: 'tenant filter helper present',
      isPresent: (content) => content.includes('applyTenantEq'),
      message: `${filePath} must retain applyTenantEq for service-role Supabase reads/deletes and tenant_id on writes.`,
    },
    {
      name: 'service-role table access tenant scoped',
      isPresent: (content) => !SUPABASE_TENANT_TABLES.some((table) => hasUnscopedSupabaseTableAccess(content, table)),
      message: `${filePath} must not use service-role tenant table reads/writes without applyTenantEq, tenant_id row data, or tenant-scoped repository helpers.`,
    },
    {
      name: 'knex tenant filter present',
      isPresent: (content) => !content.includes('getKnexClient') || content.includes('getTenantIdFromHeaders') || content.includes("where('tenant_id'") || content.includes('.where("tenant_id"') || content.includes("andWhere('tenant_id'") || content.includes('.andWhere("tenant_id"'),
      message: `${filePath} Knex paths must resolve tenant context and filter by tenant_id when reading tenant tables.`,
    },
    {
      name: 'no invalid admin client arguments',
      isPresent: (content) => !usesInvalidSupabaseAdminTenantArgument(content),
      message: `${filePath} must not call getSupabaseAdmin() with tenant arguments; tenant scope must be resolved and filtered separately.`,
    },
  ];
}

export function requiredInvariantsForFile(filePath: string): RequiredAutopilotInvariant[] {
  if (filePath.startsWith('lib/repositories/')) return repositoryInvariants(filePath);
  if (filePath === 'app/(builder)/ycode/api/publish/route.ts') return publishInvariants(filePath);
  if (filePath === 'lib/page-fetcher.ts') return pageFetcherInvariants(filePath);
  if (filePath === 'lib/services/collectionService.ts') return collectionServiceInvariants(filePath);
  return [];
}

export function inspectTenantSensitiveContent(filePath: string, content: string): string[] {
  const failures: string[] = [];
  if (hasConflictMarkers(content)) {
    failures.push(`${filePath} still contains conflict markers, so Autopilot cannot prove tenant-scope invariants safely.`);
  }

  for (const invariant of requiredInvariantsForFile(filePath)) {
    if (!invariant.isPresent(content)) {
      failures.push(`${invariant.name}: ${invariant.message}`);
    }
  }

  return failures;
}

export function invariantChecksForFile(filePath: string, content: string): AutopilotInvariantCheck[] {
  return requiredInvariantsForFile(filePath).map((invariant) => ({
    filePath,
    name: invariant.name,
    ok: invariant.isPresent(content),
    message: invariant.message,
  }));
}
