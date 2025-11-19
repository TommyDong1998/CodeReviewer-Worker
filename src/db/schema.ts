import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  uniqueIndex,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 20 }).notNull().default('member'),
  useFastModel: boolean('use_fast_model').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

export const teams = pgTable('teams', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  stripeProductId: text('stripe_product_id'),
  planName: varchar('plan_name', { length: 50 }),
  subscriptionStatus: varchar('subscription_status', { length: 20 }),
});

export const teamMembers = pgTable(
  'team_members',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    role: varchar('role', { length: 50 }).notNull(),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  (table) => ({
    oneTeamPerUser: uniqueIndex('team_members_user_unique').on(table.userId),
  })
);

export const activityLogs = pgTable('activity_logs', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  userId: integer('user_id').references(() => users.id),
  action: text('action').notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  ipAddress: varchar('ip_address', { length: 45 }),
});

export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    teamId: integer('team_id').references(() => teams.id, { onDelete: 'set null' }),
    planName: varchar('plan_name', { length: 50 }),
    modelId: varchar('model_id', { length: 255 }),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userWindowIdx: index('ai_usage_events_user_window_idx').on(table.userId, table.createdAt),
    teamWindowIdx: index('ai_usage_events_team_window_idx').on(table.teamId, table.createdAt),
  })
);

export const invitations = pgTable('invitations', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 50 }).notNull(),
  invitedBy: integer('invited_by')
    .notNull()
    .references(() => users.id),
  invitedAt: timestamp('invited_at').notNull().defaultNow(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
});

export const teamsRelations = relations(teams, ({ many }) => ({
  teamMembers: many(teamMembers),
  activityLogs: many(activityLogs),
  invitations: many(invitations),
}));

export const usersRelations = relations(users, ({ many }) => ({
  teamMembers: many(teamMembers),
  invitationsSent: many(invitations),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  team: one(teams, {
    fields: [invitations.teamId],
    references: [teams.id],
  }),
  invitedBy: one(users, {
    fields: [invitations.invitedBy],
    references: [users.id],
  }),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
}));

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  team: one(teams, {
    fields: [activityLogs.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [activityLogs.userId],
    references: [users.id],
  }),
}));

export const githubTokens = pgTable('github_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().unique(),
  accessToken: text('access_token').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const githubRepos = pgTable(
  'github_repos',
  {
    id: serial('id').primaryKey(),
    githubId: text('github_id').notNull(),
    name: text('name').notNull(),
    fullName: text('full_name').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    teamId: integer('team_id').references(() => teams.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    userRepoUnique: uniqueIndex('github_repos_user_repo_unique').on(
      table.userId,
      table.githubId,
    ),
    teamRepoUnique: uniqueIndex('github_repos_team_repo_unique').on(
      table.teamId,
      table.githubId,
    ),
  }),
);

export const codeReviews = pgTable('code_reviews', {
  id: serial('id').primaryKey(),
  repoId: integer('repo_id').notNull().references(() => githubRepos.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  branch: varchar('branch', { length: 255 }),
  commitSha: varchar('commit_sha', { length: 40 }),
  functionName: text('function_name').notNull(),
  lineStart: integer('line_start').notNull(),
  lineEnd: integer('line_end').notNull(),
  contentHash: varchar('content_hash', { length: 64 }),
  status: text('status', { enum: ['clean', 'dirty', 'unmarked'] })
    .notNull()
    .default('unmarked'),
  reason: text('reason'),
  parsedAt: timestamp('parsed_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  repoFileFunction: uniqueIndex('code_reviews_repo_file_function_idx')
    .on(table.repoId, table.filePath, table.branch, table.lineStart, table.lineEnd),
  repoBranchOrder: index('code_reviews_repo_branch_order_idx')
    .on(table.repoId, table.branch, table.filePath, table.lineStart),
}));

export const codeReviewComments = pgTable('code_review_comments', {
  id: serial('id').primaryKey(),
  repoId: integer('repo_id')
    .notNull()
    .references(() => githubRepos.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  branch: varchar('branch', { length: 255 }),
  startLine: integer('start_line').notNull(),
  endLine: integer('end_line').notNull(),
  comment: text('comment').notNull(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  resolved: boolean('resolved').notNull().default(false),
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
}, (table) => ({
  repoFileIdx: index('code_review_comments_repo_file_idx').on(table.repoId, table.filePath),
  repoBranchIdx: index('code_review_comments_repo_branch_idx').on(table.repoId, table.branch),
}));

export const codeReviewStatusEvents = pgTable('code_review_status_events', {
  id: serial('id').primaryKey(),
  repoId: integer('repo_id')
    .notNull()
    .references(() => githubRepos.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
  functionName: text('function_name').notNull(),
  lineStart: integer('line_start').notNull(),
  lineEnd: integer('line_end').notNull(),
  previousStatus: text('previous_status'),
  newStatus: text('new_status').notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  repoFileIdx: index('code_review_status_events_repo_file_idx').on(table.repoId, table.filePath),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type TeamDataWithMembers = Team & {
  teamMembers: (TeamMember & {
    user: Pick<User, 'id' | 'name' | 'email'>;
  })[];
};
export type CodeReviewComment = typeof codeReviewComments.$inferSelect;
export type NewCodeReviewComment = typeof codeReviewComments.$inferInsert;

export const securityScans = pgTable('security_scans', {
  id: serial('id').primaryKey(),
  scanId: varchar('scan_id', { length: 100 }).notNull().unique(),
  repoId: integer('repo_id')
    .notNull()
    .references(() => githubRepos.id, { onDelete: 'cascade' }),
  branch: varchar('branch', { length: 255 }).notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  teamId: integer('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 20 }).notNull().default('running'), // running, completed, failed
  toolsUsed: text('tools_used').array(),
  scanDuration: integer('scan_duration'), // milliseconds
  totalIssues: integer('total_issues').default(0),
  criticalCount: integer('critical_count').default(0),
  highCount: integer('high_count').default(0),
  mediumCount: integer('medium_count').default(0),
  lowCount: integer('low_count').default(0),
  infoCount: integer('info_count').default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
}, (table) => ({
  repoIdx: index('security_scans_repo_idx').on(table.repoId),
  teamIdx: index('security_scans_team_idx').on(table.teamId),
}));

export const securityIssues = pgTable('security_issues', {
  id: serial('id').primaryKey(),
  scanId: varchar('scan_id', { length: 100 })
    .notNull()
    .references(() => securityScans.scanId, { onDelete: 'cascade' }),
  tool: varchar('tool', { length: 20 }).notNull(), // semgrep, gitleaks, checkov, trivy, llm
  severity: varchar('severity', { length: 20 }).notNull(), // critical, high, medium, low, info
  title: text('title').notNull(),
  description: text('description').notNull(),
  filePath: text('file_path').notNull(),
  lineStart: integer('line_start').notNull(),
  lineEnd: integer('line_end'),
  code: text('code'),
  recommendation: text('recommendation'),
  cwe: text('cwe').array(),
  owasp: text('owasp').array(),
  status: varchar('status', { length: 20 }).default('open'), // open, acknowledged, fixed, false_positive
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  scanIdx: index('security_issues_scan_idx').on(table.scanId),
  severityIdx: index('security_issues_severity_idx').on(table.severity),
}));

export const scanQuotas = pgTable('scan_quotas', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' })
    .unique(),
  scansUsed: integer('scans_used').notNull().default(0),
  resetDate: timestamp('reset_date').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type SecurityScan = typeof securityScans.$inferSelect;
export type NewSecurityScan = typeof securityScans.$inferInsert;
export type SecurityIssue = typeof securityIssues.$inferSelect;
export type NewSecurityIssue = typeof securityIssues.$inferInsert;
export type ScanQuota = typeof scanQuotas.$inferSelect;
export type NewScanQuota = typeof scanQuotas.$inferInsert;

export enum ActivityType {
  SIGN_UP = 'SIGN_UP',
  SIGN_IN = 'SIGN_IN',
  SIGN_OUT = 'SIGN_OUT',
  UPDATE_PASSWORD = 'UPDATE_PASSWORD',
  DELETE_ACCOUNT = 'DELETE_ACCOUNT',
  UPDATE_ACCOUNT = 'UPDATE_ACCOUNT',
  CREATE_TEAM = 'CREATE_TEAM',
  REMOVE_TEAM_MEMBER = 'REMOVE_TEAM_MEMBER',
  INVITE_TEAM_MEMBER = 'INVITE_TEAM_MEMBER',
  ACCEPT_INVITATION = 'ACCEPT_INVITATION',
}

// API Keys for CI/CD Integration
export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  repoId: integer('repo_id')
    .notNull()
    .references(() => githubRepos.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(), // e.g., "GitHub Actions", "AWS Pipeline"
  key: varchar('key', { length: 64 }).notNull().unique(), // API key hash
  lastUsedAt: timestamp('last_used_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at'),
}, (table) => ({
  repoIdx: index('api_keys_repo_idx').on(table.repoId),
  keyIdx: index('api_keys_key_idx').on(table.key),
}));

// Quality Gate Configurations
export const qualityGates = pgTable('quality_gates', {
  id: serial('id').primaryKey(),
  repoId: integer('repo_id')
    .notNull()
    .references(() => githubRepos.id, { onDelete: 'cascade' })
    .unique(),
  enabled: boolean('enabled').notNull().default(false),
  requireAllClean: boolean('require_all_clean').notNull().default(false), // All functions must be clean
  maxCriticalIssues: integer('max_critical_issues').default(0), // Max critical security issues allowed
  maxHighIssues: integer('max_high_issues').default(5),
  minCleanPercentage: integer('min_clean_percentage').default(80), // Minimum % of functions marked clean
  blockOnUnresolvedComments: boolean('block_on_unresolved_comments').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  repoIdx: index('quality_gates_repo_idx').on(table.repoId),
}));

// Webhook Events from External Pipelines
export const webhookEvents = pgTable('webhook_events', {
  id: serial('id').primaryKey(),
  repoId: integer('repo_id')
    .notNull()
    .references(() => githubRepos.id, { onDelete: 'cascade' }),
  source: varchar('source', { length: 50 }).notNull(), // 'github-actions', 'aws-codepipeline', 'jenkins', etc.
  eventType: varchar('event_type', { length: 50 }).notNull(), // 'quality_check', 'status_update', 'deployment'
  branch: varchar('branch', { length: 255 }),
  commitSha: varchar('commit_sha', { length: 40 }),
  payload: text('payload'), // JSON string
  status: varchar('status', { length: 20 }).notNull(), // 'success', 'failure', 'pending'
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  repoIdx: index('webhook_events_repo_idx').on(table.repoId),
  sourceIdx: index('webhook_events_source_idx').on(table.source),
  createdIdx: index('webhook_events_created_idx').on(table.createdAt),
}));

// Background Scan Jobs for large repositories
export const scanJobs = pgTable('scan_jobs', {
  id: serial('id').primaryKey(),
  repoId: integer('repo_id')
    .notNull()
    .references(() => githubRepos.id, { onDelete: 'cascade' }),
  branch: varchar('branch', { length: 255 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('queued'), // 'queued', 'running', 'completed', 'failed', 'cancelled'
  progress: jsonb('progress').$type<{
    filesProcessed: number;
    totalFiles: number;
    functionsDetected: number;
    currentFile: string | null;
  }>(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  error: text('error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  repoIdx: index('scan_jobs_repo_idx').on(table.repoId),
  statusIdx: index('scan_jobs_status_idx').on(table.status),
  createdIdx: index('scan_jobs_created_idx').on(table.createdAt),
}));

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type QualityGate = typeof qualityGates.$inferSelect;
export type NewQualityGate = typeof qualityGates.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
export type ScanJob = typeof scanJobs.$inferSelect;
export type NewScanJob = typeof scanJobs.$inferInsert;
