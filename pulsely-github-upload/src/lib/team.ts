import { supabase } from './supabase'
import type { PlanId } from './plans'

export type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer'
export type Workspace = { owner_user_id: string; name: string; owner_email: string; role: TeamRole; plan: PlanId; has_override: boolean }
export type Member = { id: string; owner_user_id: string; member_user_id: string; member_email: string; role: Exclude<TeamRole, 'owner'>; created_at: string }
export type Invite = { id: string; email: string; role: Exclude<TeamRole, 'owner'>; token: string; status: 'pending' | 'accepted' | 'revoked'; expires_at: string; created_at: string }
export type IncomingInvite = Pick<Invite, 'id' | 'email' | 'role' | 'token' | 'expires_at'> & { workspace_name: string }
export type Activity = { id: string; action: string; subject: string; created_at: string; actor_user_id: string | null }

let activeWorkspace: Workspace | undefined
let userId = ''

export function workspaceId() {
  if (!activeWorkspace) throw new Error('Choose a workspace first.')
  return activeWorkspace.owner_user_id
}

export function setWorkspace(workspace: Workspace) {
  activeWorkspace = workspace
  localStorage.setItem(`pulsely.workspace.${userId}`, workspace.owner_user_id)
}

export async function loadWorkspaces() {
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError) throw authError
  if (!user) throw new Error('Sign in to continue.')
  userId = user.id
  const { data, error } = await supabase.rpc('list_workspaces')
  if (error) throw error
  const workspaces = (data ?? []) as Workspace[]
  const saved = localStorage.getItem(`pulsely.workspace.${userId}`)
  const workspace = workspaces.find(item => item.owner_user_id === saved) ?? workspaces.find(item => item.role === 'owner')
  if (!workspace) throw new Error('Your workspace could not be found.')
  setWorkspace(workspace)
  return { workspaces, workspace, userId }
}

export const canManage = (role: TeamRole) => role === 'owner' || role === 'admin'
export const canEdit = (role: TeamRole) => role !== 'viewer'

export async function getTeam() {
  const owner = workspaceId()
  const results = await Promise.all([
    supabase.from('team_members').select('*').eq('owner_user_id', owner).order('created_at'),
    supabase.from('team_invites').select('*').eq('owner_user_id', owner).order('created_at', { ascending: false }),
    supabase.rpc('pending_workspace_invites'),
    supabase.from('workspace_activity').select('*').eq('owner_user_id', owner).order('created_at', { ascending: false }).limit(30),
  ])
  for (const result of results) if (result.error) throw result.error
  return { members: results[0].data as Member[], invites: results[1].data as Invite[], incoming: results[2].data as IncomingInvite[], activity: results[3].data as Activity[] }
}

export async function inviteMember(email: string, role: string) {
  const { data, error } = await supabase.rpc('create_workspace_invite', { target_owner: workspaceId(), invite_email: email.trim(), invite_role: role })
  if (error) throw error
  return data as Invite
}

export function inviteLink(token: string) {
  return `${window.location.origin}${window.location.pathname}#invite=${encodeURIComponent(token)}`
}

export async function revokeInvite(id: string) {
  const { error } = await supabase.rpc('revoke_workspace_invite', { invite_id: id })
  if (error) throw error
}

export async function acceptInvite(token: string) {
  const { data, error } = await supabase.rpc('accept_team_invite', { invite_token: token })
  if (error) throw error
  localStorage.setItem(`pulsely.workspace.${userId}`, data as string)
  return data as string
}

export async function changeMember(id: string, role: string | null) {
  const { error } = await supabase.rpc('change_workspace_member', { member_id: id, new_role: role })
  if (error) throw error
}

export async function renameWorkspace(name: string) {
  const { error } = await supabase.rpc('rename_workspace', { target_owner: workspaceId(), workspace_name: name.trim() })
  if (error) throw error
}
