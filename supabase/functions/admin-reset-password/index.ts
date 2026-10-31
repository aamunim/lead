// =====================================================================
// 🔑 An admin sets a new password for a user
//   POST { user_id, password, must_change }
//   Only people with "users.manage" (admins). Nobody but a Super Admin
//   may reset a Super Admin, and nobody resets their own here (Change
//   password in the app does that). The user is signed out everywhere;
//   with must_change they pick their own password at the next sign-in.
// =====================================================================
import { admin, cors, currentUser, json } from '../_shared/drive.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);
  try {
    const me = await currentUser(req);
    if (!me) return json({ error: 'Please sign in again.' }, 401);

    const body = (await req.json().catch(() => ({}))) as { user_id?: string; password?: string; must_change?: boolean };
    const userId = String(body.user_id ?? '');
    const password = String(body.password ?? '');
    const mustChange = body.must_change !== false;

    if (!userId) return json({ error: 'No user.' }, 400);
    if (userId === me.id) return json({ error: 'To change your own password, use More → Change password.' }, 400);
    if (password.length < 8) return json({ error: 'The password must be at least 8 characters.' }, 400);

    // Who is asking, and who is it for (roles and their permissions)
    const { data: people, error } = await admin
      .from('profiles')
      .select('id, full_name, role_key, is_active, role:roles(permissions)')
      .in('id', [me.id, userId]);
    if (error) throw new Error(error.message);
    const caller = people?.find((p) => p.id === me.id) as
      | { role_key: string; is_active: boolean; role: { permissions: string[] } | null }
      | undefined;
    const target = people?.find((p) => p.id === userId) as { full_name: string | null; role_key: string } | undefined;

    const perms = caller?.role?.permissions ?? [];
    if (!caller?.is_active || !(perms.includes('*') || perms.includes('users.manage'))) {
      return json({ error: 'Only an admin can reset passwords.' }, 403);
    }
    if (!target) return json({ error: 'User not found.' }, 404);
    if (target.role_key === 'super_admin' && caller.role_key !== 'super_admin') {
      return json({ error: 'Only a Super Admin can reset a Super Admin’s password.' }, 403);
    }

    const { error: pwError } = await admin.auth.admin.updateUserById(userId, { password });
    if (pwError) return json({ error: pwError.message }, 400);

    // Signed out everywhere; a new password of their own at the next sign-in
    await admin.rpc('revoke_user_sessions', { p_user: userId });
    await admin.from('profiles').update({ must_change_password: mustChange }).eq('id', userId);
    await admin.from('user_events').insert({
      user_id: userId,
      by_user: me.id,
      action: 'password_reset',
      details: { must_change: mustChange },
    });

    return json({ ok: true, name: target.full_name });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
