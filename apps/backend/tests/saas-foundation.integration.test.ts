import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import type { EmailMessage, EmailProvider } from "../src/mail/email-provider.js";
import { setEmailProviderForTests } from "../src/mail/index.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const app = buildApp();
const password = "multi-workspace-42";
const suffix = randomUUID();
const ownerEmail = `owner-${suffix}@test.local`;
const adminEmail = `admin-${suffix}@test.local`;
const operatorEmail = `operator-${suffix}@test.local`;
const managedMemberEmail = `managed-${suffix}@test.local`;
const rootEmail = `root-${suffix}@test.local`;
const invitedEmail = `invited-${suffix}@test.local`;
const expiredEmail = `expired-${suffix}@test.local`;
const disabledInviteEmail = `disabled-invite-${suffix}@test.local`;
const failedEmail = `failed-email-${suffix}@test.local`;
const initialOwnerEmail = `initial-owner-${suffix}@test.local`;
const rootInvitedEmail = `root-invited-${suffix}@test.local`;

let tenantA = "";
let tenantB = "";
let tenantC = "";
let rootCreatedTenant = "";
let conversationA = "";
const sentEmails: EmailMessage[] = [];
const fakeEmailProvider: EmailProvider = {
  isConfigured: true,
  async send(message) {
    sentEmails.push(message);
  }
};
let loginCounter = 1;

async function login(email: string, loginPassword = password) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    remoteAddress: `10.44.0.${loginCounter++}`,
    payload: { email, password: loginPassword }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"]!;
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
}

beforeAll(async () => {
  setEmailProviderForTests(fakeEmailProvider);
  await app.ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    tenantA = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Alpha SaaS ${suffix}`, `alpha-saas-${suffix}`])).rows[0].id;
    tenantB = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Beta SaaS ${suffix}`, `beta-saas-${suffix}`])).rows[0].id;
    tenantC = (await client.query<{ id: string }>("INSERT INTO tenants(name,slug,status) VALUES($1,$2,'active') RETURNING id", [`Gamma SaaS ${suffix}`, `gamma-saas-${suffix}`])).rows[0].id;
    for (const tenantId of [tenantA, tenantB, tenantC]) await ensureWorkspaceDefaultRoles(client, tenantId);
    await client.query(
      `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
       SELECT tenant.id,definition.flag_key,true
       FROM unnest($1::uuid[]) tenant(id)
       CROSS JOIN feature_flag_definitions definition
       WHERE definition.kind='capability'
         AND definition.availability_mode='all_tenants'
       ON CONFLICT (tenant_id,flag_key) DO UPDATE
       SET enabled=EXCLUDED.enabled`,
      [[tenantA, tenantB, tenantC]]
    );

    const passwordHash = await hash(password, 4);
    const owner = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [ownerEmail, passwordHash]
    );
    const operator = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [operatorEmail, passwordHash]
    );
    const admin = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [adminEmail, passwordHash]
    );
    const managedMember = await client.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,status) VALUES($1,$2,'active') RETURNING id",
      [managedMemberEmail, passwordHash]
    );
    await client.query(
      "INSERT INTO users(email,password_hash,status,is_root) VALUES($1,$2,'active',true)",
      [rootEmail, passwordHash]
    );

    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT workspace_id,$2,id,'active',now() FROM workspace_roles
       WHERE workspace_id=ANY($1::uuid[]) AND name='OWNER'`,
      [[tenantA, tenantB], owner.rows[0].id]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now() FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'`,
      [tenantA, operator.rows[0].id]
    );
    await client.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,member_user.user_id,id,'active',now()
       FROM workspace_roles
       CROSS JOIN unnest($2::uuid[]) AS member_user(user_id)
       WHERE workspace_id=$1 AND name=CASE WHEN member_user.user_id=$3 THEN 'ADMIN' ELSE 'OPERADOR' END`,
      [tenantA, [admin.rows[0].id, managedMember.rows[0].id], admin.rows[0].id]
    );

    for (const [tenantId, model] of [[tenantA, "model-alpha"], [tenantB, "model-beta"]] as const) {
      const session = await client.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId]);
      await client.query("INSERT INTO agent_configs(tenant_id,system_prompt,ai_model) VALUES($1,$2,$3)", [tenantId, `prompt-${model}`, model]);
      const conversation = await client.query<{ id: string }>(
        "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,$3) RETURNING id",
        [tenantId, session.rows[0].id, tenantId === tenantA ? "5511900000001" : "5511900000002"]
      );
      if (tenantId === tenantA) {
        conversationA = conversation.rows[0].id;
        await client.query("INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact','reset root')", [conversationA]);
        await client.query("INSERT INTO usage_logs(tenant_id,conversation_id,ai_model,input_tokens,output_tokens,cost_usd) VALUES($1,$2,'model-alpha',1,1,0.01)", [tenantA, conversationA]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  setEmailProviderForTests(undefined);
  await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email=ANY($1::text[]))", [[ownerEmail, adminEmail, operatorEmail, managedMemberEmail, rootEmail, invitedEmail, expiredEmail, disabledInviteEmail, failedEmail, initialOwnerEmail]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantA, tenantB, tenantC, rootCreatedTenant].filter(Boolean)]);
  await pool.query("DELETE FROM users WHERE email=ANY($1::text[])", [[ownerEmail, adminEmail, operatorEmail, managedMemberEmail, rootEmail, invitedEmail, expiredEmail, disabledInviteEmail, failedEmail, initialOwnerEmail, rootInvitedEmail]]);
  await pool.end();
  await app.close();
});

describe("SaaS foundation auth and RBAC", () => {
  it("returns memberships and switches active workspace without mixing tenant data", async () => {
    const cookie = await login(ownerEmail);
    const me = await app.inject({ url: "/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().workspaces.map((workspace: { id: string }) => workspace.id)).toEqual([tenantA, tenantB]);
    expect(me.json().activeWorkspace.timezone).toBe("UTC");
    expect(me.json().permissions).toContain("agent.manage");

    const switched = await app.inject({ method: "POST", url: "/workspaces/switch", headers: { cookie }, payload: { workspaceId: tenantB } });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().activeWorkspace).toMatchObject({ id: tenantB, role: "OWNER" });
    const nextCookie = (Array.isArray(switched.headers["set-cookie"]) ? switched.headers["set-cookie"][0] : switched.headers["set-cookie"]!).split(";")[0];
    const dashboard = await app.inject({ url: "/dashboard", headers: { cookie: nextCookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().tenant.name).toContain("Beta SaaS");
    expect(dashboard.json().agent).toBeNull();
    expect((await app.inject({ url: "/agent", headers: { cookie: nextCookie } })).statusCode).toBe(403);
  });

  it("rejects switching to a workspace without membership", async () => {
    const cookie = await login(ownerEmail);
    const response = await app.inject({ method: "POST", url: "/workspaces/switch", headers: { cookie }, payload: { workspaceId: tenantC } });
    expect(response.statusCode).toBe(403);
  });

  it("gives ROOT every permission after login and workspace switching, including invitations", async () => {
    const rootCookie = await login(rootEmail);
    const initialMe = await app.inject({ url: "/me", headers: { cookie: rootCookie } });
    expect(initialMe.statusCode).toBe(200);
    expect(initialMe.json()).toMatchObject({
      actorScope: "root",
      rootWorkspaceAccess: true,
      activeWorkspace: { role: "ROOT" }
    });
    expect(initialMe.json().permissions).toEqual(expect.arrayContaining([
      "members.invite",
      "members.update",
      "members.remove",
      "roles.create",
      "workspace.update"
    ]));

    const switched = await app.inject({
      method: "POST",
      url: "/workspaces/switch",
      headers: { cookie: rootCookie },
      payload: { workspaceId: tenantC }
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toMatchObject({
      actorScope: "root",
      rootWorkspaceAccess: true,
      activeWorkspace: { id: tenantC, role: "ROOT" }
    });
    expect(switched.json().permissions).toContain("members.invite");

    const switchedCookie = (Array.isArray(switched.headers["set-cookie"]) ? switched.headers["set-cookie"][0] : switched.headers["set-cookie"]!).split(";")[0];
    const roles = await app.inject({ url: "/workspaces/current/roles", headers: { cookie: switchedCookie } });
    expect(roles.statusCode).toBe(200);
    const adminRole = roles.json().roles.find((role: { name: string }) => role.name === "ADMIN");
    const invitation = await app.inject({
      method: "POST",
      url: "/workspaces/current/invitations",
      headers: { cookie: switchedCookie },
      payload: { email: rootInvitedEmail, roleId: adminRole.id }
    });
    expect(invitation.statusCode).toBe(201);
    expect(invitation.json().invitation).toMatchObject({ email: rootInvitedEmail, roleId: adminRole.id });
  });

  it("blocks disabled users on fresh login and stale cookies", async () => {
    const cookie = await login(operatorEmail);
    await pool.query("UPDATE users SET status='disabled' WHERE email=$1", [operatorEmail]);
    const loginResponse = await app.inject({ method: "POST", url: "/auth/login", payload: { email: operatorEmail, password } });
    expect(loginResponse.statusCode).toBe(401);
    const stale = await app.inject({ url: "/dashboard", headers: { cookie } });
    expect(stale.statusCode).toBe(401);
    await pool.query("UPDATE users SET status='active' WHERE email=$1", [operatorEmail]);
  });

  it("denies routes when the active role lacks the required permission", async () => {
    const cookie = await login(operatorEmail);
    const response = await app.inject({ url: "/agent", headers: { cookie } });
    expect(response.statusCode).toBe(403);
  });

  it("requires the current password when a valid invitation belongs to an existing account", async () => {
    const rootCookie = await login(rootEmail);
    const access = await app.inject({ method: "POST", url: `/root/workspaces/${tenantC}/access`, headers: { cookie: rootCookie } });
    expect(access.statusCode).toBe(200);
    const accessCookie = (Array.isArray(access.headers["set-cookie"]) ? access.headers["set-cookie"][0] : access.headers["set-cookie"]!).split(";")[0];
    const roles = await app.inject({ url: "/workspaces/current/roles", headers: { cookie: accessCookie } });
    const adminRole = roles.json().roles.find((role: { name: string }) => role.name === "ADMIN");
    const invitation = await app.inject({
      method: "POST",
      url: "/workspaces/current/invitations",
      headers: { cookie: accessCookie },
      payload: { email: operatorEmail, roleId: adminRole.id }
    });
    expect(invitation.statusCode).toBe(201);
    const token = invitation.json().token;

    expect((await app.inject({ url: `/invitations/${"x".repeat(64)}` })).statusCode).toBe(404);
    const publicInvite = await app.inject({ url: `/invitations/${token}` });
    expect(publicInvite.statusCode).toBe(200);
    expect(publicInvite.json().invitation).toMatchObject({ email: operatorEmail, status: "pending", existingUser: true });

    const newPasswordAttempt = await app.inject({
      method: "POST",
      url: "/auth/accept-invitation",
      payload: { token, newPassword: "replacement-password", passwordConfirmation: "replacement-password" }
    });
    expect(newPasswordAttempt.statusCode).toBe(400);
    const wrongPassword = await app.inject({ method: "POST", url: "/auth/accept-invitation", payload: { token, currentPassword: "incorrect-password" } });
    expect(wrongPassword.statusCode).toBe(401);
    const accepted = await app.inject({ method: "POST", url: "/auth/accept-invitation", payload: { token, currentPassword: password } });
    expect(accepted.statusCode).toBe(200);
    expect((await app.inject({ url: `/invitations/${token}` })).json().invitation).toMatchObject({ status: "accepted", existingUser: true });
  });

  it("lets ADMIN reset a member password and requires a new password on the next login", async () => {
    const adminCookie = await login(adminEmail);
    const members = await app.inject({ url: "/workspaces/current/members", headers: { cookie: adminCookie } });
    const managedMember = members.json().members.find((member: { email: string }) => member.email === managedMemberEmail);
    const ownerMember = members.json().members.find((member: { email: string }) => member.email === ownerEmail);

    expect((await app.inject({
      method: "PATCH",
      url: `/workspaces/current/members/${ownerMember.id}/profile`,
      headers: { cookie: adminCookie },
      payload: { name: "Alteração indevida" }
    })).statusCode).toBe(403);

    const staleMemberCookie = await login(managedMemberEmail);
    const reset = await app.inject({
      method: "PATCH",
      url: `/workspaces/current/members/${managedMember.id}/profile`,
      headers: { cookie: adminCookie, "user-agent": "member-profile-test" },
      payload: {
        name: "Membro Gerenciado",
        newPassword: "Mudar123",
        mustChangePassword: true
      }
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().member).toMatchObject({
      name: "Membro Gerenciado",
      must_change_password: true
    });
    expect((await app.inject({ url: "/me", headers: { cookie: staleMemberCookie } })).statusCode).toBe(401);

    const temporaryLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: `10.44.0.${loginCounter++}`,
      payload: { email: managedMemberEmail, password: "Mudar123" }
    });
    expect(temporaryLogin.statusCode).toBe(200);
    expect(temporaryLogin.json().user.mustChangePassword).toBe(true);
    const temporaryCookieHeader = temporaryLogin.headers["set-cookie"]!;
    const temporaryCookie = (Array.isArray(temporaryCookieHeader) ? temporaryCookieHeader[0] : temporaryCookieHeader).split(";")[0];
    expect((await app.inject({ url: "/me", headers: { cookie: temporaryCookie } })).statusCode).toBe(428);

    const mismatch = await app.inject({
      method: "POST",
      url: "/auth/password-change-required",
      headers: { cookie: temporaryCookie },
      payload: { newPassword: "SenhaPessoal123", passwordConfirmation: "SenhaDiferente123" }
    });
    expect(mismatch.statusCode).toBe(400);

    const changed = await app.inject({
      method: "POST",
      url: "/auth/password-change-required",
      headers: { cookie: temporaryCookie },
      payload: { newPassword: "SenhaPessoal123", passwordConfirmation: "SenhaPessoal123" }
    });
    expect(changed.statusCode).toBe(200);
    const changedCookieHeader = changed.headers["set-cookie"]!;
    const changedCookie = (Array.isArray(changedCookieHeader) ? changedCookieHeader[0] : changedCookieHeader).split(";")[0];
    const me = await app.inject({ url: "/me", headers: { cookie: changedCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ name: "Membro Gerenciado", mustChangePassword: false });

    expect((await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: `10.44.0.${loginCounter++}`,
      payload: { email: managedMemberEmail, password: "Mudar123" }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST",
      url: "/auth/login",
      remoteAddress: `10.44.0.${loginCounter++}`,
      payload: { email: managedMemberEmail, password: "SenhaPessoal123" }
    })).statusCode).toBe(200);

    await pool.query(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,user_account.id,role.id,'active',now()
       FROM users user_account
       JOIN workspace_roles role ON role.workspace_id=$1 AND role.name='OPERADOR'
       WHERE user_account.email=$2`,
      [tenantB, managedMemberEmail]
    );
    const crossWorkspaceReset = await app.inject({
      method: "PATCH",
      url: `/workspaces/current/members/${managedMember.id}/profile`,
      headers: { cookie: adminCookie },
      payload: { name: "Identidade alterada por outro tenant" }
    });
    expect(crossWorkspaceReset.statusCode).toBe(409);
    expect(crossWorkspaceReset.json().error).toMatch(/outros workspaces/);

    const rootIdentityCookie = await login(rootEmail);
    const rootAccess = await app.inject({
      method: "POST",
      url: `/root/workspaces/${tenantA}/access`,
      headers: { cookie: rootIdentityCookie }
    });
    expect(rootAccess.statusCode).toBe(200);
    const rootAccessCookieHeader = rootAccess.headers["set-cookie"]!;
    const rootCookie = (Array.isArray(rootAccessCookieHeader) ? rootAccessCookieHeader[0] : rootAccessCookieHeader).split(";")[0];
    const rootUpdate = await app.inject({
      method: "PATCH",
      url: `/workspaces/current/members/${managedMember.id}/profile`,
      headers: { cookie: rootCookie },
      payload: { name: "Membro Gerenciado por ROOT" }
    });
    expect(rootUpdate.statusCode).toBe(200);
    expect(rootUpdate.json().member.name).toBe("Membro Gerenciado por ROOT");

    const audit = await pool.query<{ metadata: Record<string, unknown>; serialized: string }>(
      `SELECT metadata,metadata::text serialized
       FROM audit_logs
       WHERE actor_user_id=(SELECT id FROM users WHERE email=$1)
         AND action='members.profile.update'
       ORDER BY created_at DESC LIMIT 1`,
      [adminEmail]
    );
    expect(audit.rows[0].metadata).toMatchObject({
      nameChanged: true,
      passwordReset: true,
      mustChangePassword: true
    });
    expect(audit.rows[0].serialized).not.toContain("Mudar123");
    expect(audit.rows[0].serialized).not.toContain("SenhaPessoal123");
  });

  it("manages roles, members and invitations while preserving owner invariants", async () => {
    const cookie = await login(ownerEmail);
    const rootCookie = await login(rootEmail);
    const rootAccess = await app.inject({ method: "POST", url: `/root/workspaces/${tenantA}/access`, headers: { cookie: rootCookie } });
    expect(rootAccess.statusCode).toBe(200);
    const rootAccessCookie = (Array.isArray(rootAccess.headers["set-cookie"]) ? rootAccess.headers["set-cookie"][0] : rootAccess.headers["set-cookie"]!).split(";")[0];
    expect((await app.inject({ url: "/workspaces/current/roles", headers: { cookie } })).statusCode).toBe(403);
    const roles = await app.inject({ url: "/workspaces/current/roles", headers: { cookie: rootAccessCookie } });
    expect(roles.statusCode).toBe(200);
    const ownerRole = roles.json().roles.find((role: { name: string }) => role.name === "OWNER");
    const adminRole = roles.json().roles.find((role: { name: string }) => role.name === "ADMIN");
    const ownerMember = (await app.inject({ url: "/workspaces/current/members", headers: { cookie } }))
      .json().members.find((member: { email: string }) => member.email === ownerEmail);
    const adminMember = (await app.inject({ url: "/workspaces/current/members", headers: { cookie } }))
      .json().members.find((member: { email: string }) => member.email === adminEmail);

    expect((await app.inject({ method: "DELETE", url: `/workspaces/current/members/${ownerMember.id}`, headers: { cookie } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: `/workspaces/current/members/${ownerMember.id}`, headers: { cookie }, payload: { roleId: adminRole.id } })).statusCode).toBe(409);
    const adminCookie = await login(adminEmail);
    const ownerAssignableRoles = await app.inject({
      url: "/workspaces/current/member-roles",
      headers: { cookie }
    });
    expect(ownerAssignableRoles.statusCode).toBe(200);
    expect(ownerAssignableRoles.json().roles.map((role: { name: string }) => role.name))
      .toContain("ADMIN");
    const adminAssignableRoles = await app.inject({
      url: "/workspaces/current/member-roles",
      headers: { cookie: adminCookie }
    });
    expect(adminAssignableRoles.statusCode).toBe(200);
    expect(adminAssignableRoles.json().roles.map((role: { name: string }) => role.name))
      .not.toContain("ADMIN");
    expect((await app.inject({ method: "PATCH", url: `/workspaces/current/members/${adminMember.id}`, headers: { cookie: adminCookie }, payload: { status: "suspended" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/workspaces/current/members/${adminMember.id}`, headers: { cookie: adminCookie } })).statusCode).toBe(403);

    const customRole = await app.inject({
      method: "POST",
      url: "/workspaces/current/roles",
      headers: { cookie: rootAccessCookie },
      payload: { name: "agenda externa", description: "Agenda sem conversas", permissions: ["appointments.read", "appointments.create"] }
    });
    expect(customRole.statusCode).toBe(201);
    const customRoleId = customRole.json().role.id;
    expect((await app.inject({ method: "PUT", url: `/workspaces/current/roles/${ownerRole.id}`, headers: { cookie: rootAccessCookie }, payload: { name: "OWNER", permissions: ["dashboard.read"] } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/workspaces/current/roles/${adminRole.id}`, headers: { cookie: rootAccessCookie }, payload: { name: "ADMIN", permissions: ["dashboard.read"] } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/workspaces/current/roles/${adminRole.id}`, headers: { cookie }, payload: { name: "ADMIN", permissions: ["dashboard.read"] } })).statusCode).toBe(403);

    const disposableRole = await app.inject({
      method: "POST",
      url: "/workspaces/current/roles",
      headers: { cookie: rootAccessCookie },
      payload: { name: "temporaria", permissions: ["dashboard.read"] }
    });
    expect(disposableRole.statusCode).toBe(201);
    expect((await app.inject({ method: "DELETE", url: `/workspaces/current/roles/${disposableRole.json().role.id}`, headers: { cookie: rootAccessCookie } })).statusCode).toBe(204);
    expect((await app.inject({ url: "/workspaces/current/audit-logs", headers: { cookie } })).statusCode).toBe(200);

    const invitation = await app.inject({
      method: "POST",
      url: "/workspaces/current/invitations",
      headers: { cookie },
      payload: { email: invitedEmail, roleId: customRoleId }
    });
    expect(invitation.statusCode).toBe(201);
    const token = invitation.json().token;
    expect(token).toEqual(expect.any(String));
    expect(sentEmails.at(-1)).toMatchObject({
      to: invitedEmail,
      subject: expect.stringContaining("Alpha SaaS")
    });
    expect(sentEmails.at(-1)?.text).toContain(token);
    expect(sentEmails.at(-1)?.html).toContain("/convite?token=");
    const publicInvite = await app.inject({ url: `/invitations/${token}` });
    expect(publicInvite.statusCode).toBe(200);
    expect(publicInvite.json().invitation).toMatchObject({ email: invitedEmail, role_name: "AGENDA EXTERNA", status: "pending", existingUser: false });

    const mismatchedConfirmation = await app.inject({ method: "POST", url: "/auth/accept-invitation", payload: { token, newPassword: "new-member-password", passwordConfirmation: "different-password" } });
    expect(mismatchedConfirmation.statusCode).toBe(400);
    const accepted = await app.inject({ method: "POST", url: "/auth/accept-invitation", payload: { token, newPassword: "new-member-password", passwordConfirmation: "new-member-password" } });
    expect(accepted.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/accept-invitation", payload: { token, currentPassword: "new-member-password" } })).statusCode).toBe(409);
    const privilegedCustomRole = await app.inject({
      method: "PUT",
      url: `/workspaces/current/roles/${customRoleId}`,
      headers: { cookie: rootAccessCookie },
      payload: { name: "agenda externa", description: "Agenda e convites limitados", permissions: ["appointments.read", "appointments.create", "members.read", "members.invite", "roles.read", "roles.create"] }
    });
    expect(privilegedCustomRole.statusCode).toBe(200);
    const limitedCookie = await login(invitedEmail, "new-member-password");
    const escalationAttempt = await app.inject({
      method: "POST",
      url: "/workspaces/current/invitations",
      headers: { cookie: limitedCookie },
      payload: { email: `escalation-${suffix}@test.local`, roleId: adminRole.id }
    });
    expect(escalationAttempt.statusCode).toBe(403);
    const roleEscalationAttempt = await app.inject({
      method: "POST",
      url: "/workspaces/current/roles",
      headers: { cookie: limitedCookie },
      payload: { name: "escalacao bloqueada", permissions: ["roles.delete"] }
    });
    expect(roleEscalationAttempt.statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/workspaces/current/roles/${customRoleId}`, headers: { cookie: rootAccessCookie } })).statusCode).toBe(409);

    const reinvite = await app.inject({
      method: "POST",
      url: "/workspaces/current/invitations",
      headers: { cookie },
      payload: { email: operatorEmail, roleId: adminRole.id }
    });
    expect(reinvite.statusCode).toBe(409);
    await login(operatorEmail);
    const updatedMembers = await app.inject({ url: "/workspaces/current/members", headers: { cookie } });
    const operatorMember = updatedMembers.json().members.find((member: { email: string }) => member.email === operatorEmail);
    const transferred = await app.inject({ method: "POST", url: "/workspaces/current/owner-transfer", headers: { cookie }, payload: { memberId: operatorMember.id } });
    expect(transferred.statusCode).toBe(200);
    expect((await app.inject({ url: "/workspaces/current/members", headers: { cookie } })).statusCode).toBe(401);
    const operatorCookie = await login(operatorEmail);
    const afterTransfer = await app.inject({ url: "/workspaces/current/members", headers: { cookie: operatorCookie } });
    const owners = afterTransfer.json().members.filter((member: { role_name: string }) => member.role_name === "OWNER");
    expect(owners).toHaveLength(1);
    expect(owners[0].email).toBe(operatorEmail);
    expect((await app.inject({ method: "POST", url: "/workspaces/current/owner-transfer", headers: { cookie }, payload: { memberId: ownerMember.id } })).statusCode).toBe(401);

    const expired = await app.inject({
      method: "POST",
      url: "/workspaces/current/invitations",
      headers: { cookie: operatorCookie },
      payload: { email: expiredEmail, roleId: adminRole.id }
    });
    await pool.query("UPDATE workspace_invitations SET expires_at=now() - interval '1 second' WHERE token_hash=encode(digest($1,'sha256'),'hex')", [expired.json().token]);
    expect((await app.inject({ url: `/invitations/${expired.json().token}` })).json().invitation).toMatchObject({ status: "expired", existingUser: false });
    expect((await app.inject({ method: "POST", url: "/auth/accept-invitation", payload: { token: expired.json().token, newPassword: "expired-password", passwordConfirmation: "expired-password" } })).statusCode).toBe(409);

    await pool.query("INSERT INTO users(email,password_hash,status) VALUES($1,$2,'disabled')", [disabledInviteEmail, await hash("disabled-password", 4)]);
    const disabledInvite = await app.inject({
      method: "POST",
      url: "/workspaces/current/invitations",
      headers: { cookie: operatorCookie },
      payload: { email: disabledInviteEmail, roleId: adminRole.id }
    });
    expect(disabledInvite.statusCode).toBe(201);
    expect((await app.inject({ url: `/invitations/${disabledInvite.json().token}` })).json().invitation.existingUser).toBe(true);
    expect((await app.inject({ method: "POST", url: "/auth/accept-invitation", payload: { token: disabledInvite.json().token, currentPassword: "disabled-password" } })).statusCode).toBe(403);

    setEmailProviderForTests({ isConfigured: true, async send() { throw new Error("SMTP unavailable"); } });
    const failedInvite = await app.inject({
      method: "POST",
      url: "/workspaces/current/invitations",
      headers: { cookie: operatorCookie },
      payload: { email: failedEmail, roleId: adminRole.id }
    });
    expect(failedInvite.statusCode).toBe(201);
    expect(failedInvite.json().emailDelivery).toMatchObject({ status: "failed" });
    const failedStatus = await pool.query<{ status: string }>("SELECT status FROM workspace_invitations WHERE email=$1", [failedEmail]);
    expect(failedStatus.rows[0]?.status).toBe("pending");
    expect((await app.inject({ method: "DELETE", url: `/workspaces/current/invitations/${failedInvite.json().invitation.id}`, headers: { cookie: operatorCookie } })).statusCode).toBe(204);
    expect((await app.inject({ url: `/invitations/${failedInvite.json().token}` })).json().invitation).toMatchObject({ status: "revoked", existingUser: false });
    setEmailProviderForTests(fakeEmailProvider);
  });

  it("lets ROOT create a workspace and invite its initial OWNER", async () => {
    const rootCookie = await login(rootEmail);
    const forbidden = await app.inject({ method: "POST", url: "/root/workspaces", headers: { cookie: await login(ownerEmail) }, payload: { name: "Forbidden", ownerEmail: initialOwnerEmail } });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/root/workspaces",
      headers: { cookie: rootCookie, "user-agent": "saas-foundation-test" },
      payload: {
        name: `Root Created ${suffix}`,
        slug: `root-created-${suffix}`,
        ownerEmail: initialOwnerEmail,
        capabilityTemplateTenantId: tenantA
      }
    });
    expect(created.statusCode).toBe(201);
    rootCreatedTenant = created.json().workspace.id;
    expect(created.json().ownerInvitation).toMatchObject({ email: initialOwnerEmail });
    expect(created.json().capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "dashboard_v1", enabled: expect.any(Boolean) }),
      expect.objectContaining({ key: "appointments_v1", enabled: expect.any(Boolean) })
    ]));
    expect(created.json().capabilities.some((item: { key: string }) => item.key === "tripz_ai_v1")).toBe(false);
    expect(created.json().token).toEqual(expect.any(String));
    expect(sentEmails.at(-1)).toMatchObject({
      to: initialOwnerEmail,
      subject: expect.stringContaining(`Root Created ${suffix}`)
    });
    expect(sentEmails.at(-1)?.text).toContain(created.json().token);
    expect((await pool.query("SELECT id FROM whatsapp_sessions WHERE tenant_id=$1", [rootCreatedTenant])).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM agent_configs WHERE tenant_id=$1", [rootCreatedTenant])).rowCount).toBe(1);
    const initialSubscription = await pool.query<{ code: string; status: string }>("SELECT p.code,s.status FROM tenant_subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.tenant_id=$1", [rootCreatedTenant]);
    expect(initialSubscription.rows).toEqual([{ code: "LEGACY_UNLIMITED", status: "ACTIVE" }]);

    await pool.query("DELETE FROM tenant_subscriptions WHERE tenant_id=$1", [tenantC]);
    const targetPlan = (await pool.query<{ id: string }>("SELECT id FROM plans WHERE status='active' AND code <> 'LEGACY_UNLIMITED' ORDER BY position LIMIT 1")).rows[0];
    if (!targetPlan) throw new Error("No active commercial plan available for integration test");
    const linked = await app.inject({ method: "POST", url: `/root/saas/tenants/${tenantC}/subscription`, headers: { cookie: rootCookie }, payload: { planId: targetPlan.id } });
    expect(linked.statusCode).toBe(200);
    expect((await pool.query("SELECT id FROM tenant_subscriptions WHERE tenant_id=$1", [tenantC])).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM subscription_events WHERE tenant_id=$1 AND event_type='PLAN_CHANGED'", [tenantC])).rowCount).toBe(1);
    expect((await pool.query("SELECT id FROM audit_logs WHERE workspace_id=$1 AND action='saas.subscription.change_plan'", [tenantC])).rowCount).toBe(1);

    const suspended = await app.inject({ method: "PATCH", url: `/root/workspaces/${rootCreatedTenant}`, headers: { cookie: rootCookie }, payload: { status: "suspended" } });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().workspace.status).toBe("suspended");
    const accessSuspended = await app.inject({ method: "POST", url: `/root/workspaces/${rootCreatedTenant}/access`, headers: { cookie: rootCookie } });
    expect(accessSuspended.statusCode).toBe(404);
    const acceptSuspended = await app.inject({ method: "POST", url: "/auth/accept-invitation", payload: { token: created.json().token, newPassword: "initial-owner-password", passwordConfirmation: "initial-owner-password" } });
    expect(acceptSuspended.statusCode).toBe(403);
    const reactivated = await app.inject({ method: "PATCH", url: `/root/workspaces/${rootCreatedTenant}`, headers: { cookie: rootCookie }, payload: { status: "active" } });
    expect(reactivated.statusCode).toBe(200);
    const rootAccess = await app.inject({ method: "POST", url: `/root/workspaces/${rootCreatedTenant}/access`, headers: { cookie: rootCookie } });
    expect(rootAccess.statusCode).toBe(200);
    expect(rootAccess.json()).toMatchObject({ activeWorkspace: { id: rootCreatedTenant, role: "ROOT" }, actorScope: "root", rootWorkspaceAccess: true });
    const rootAccessCookie = (Array.isArray(rootAccess.headers["set-cookie"]) ? rootAccess.headers["set-cookie"][0] : rootAccess.headers["set-cookie"]!).split(";")[0];
    const rootDashboard = await app.inject({ url: "/dashboard", headers: { cookie: rootAccessCookie } });
    expect(rootDashboard.statusCode).toBe(200);
    expect(rootDashboard.json().tenant.name).toContain(`Root Created ${suffix}`);
    const usageResponse = await app.inject({ url: "/usage", headers: { cookie: rootAccessCookie } });
    expect(usageResponse.statusCode).toBe(200);
    expect(usageResponse.headers["cache-control"]).toBe("no-store");
    expect((await app.inject({ url: "/usage/credits", headers: { cookie: rootAccessCookie } })).json()).toEqual({ status: "not_configured" });
    await pool.query(
      "INSERT INTO usage_logs(tenant_id,ai_model,input_tokens,output_tokens,cost_usd) VALUES($1,'=2+3',1,1,0.01)",
      [rootCreatedTenant]
    );
    const usageExport = await app.inject({ url: "/usage/export", headers: { cookie: rootAccessCookie } });
    expect(usageExport.statusCode).toBe(200);
    expect(usageExport.payload).toContain("'=2+3");
    const rootAgent = await app.inject({
      method: "PUT",
      url: "/agent",
      headers: { cookie: rootAccessCookie },
      payload: {
        systemPrompt: "prompt editado pelo ROOT",
        aiModel: "root/model",
        openRouterProvider: "openai",
        temperature: 0.4,
        maxTokens: 512,
        isActive: true,
        mediaFallbackAudio: "Não consigo ouvir áudio agora.",
        mediaFallbackImage: "Não consigo analisar imagem agora.",
        mediaFallbackDocument: "Não consigo abrir documento agora."
      }
    });
    expect(rootAgent.statusCode).toBe(202);
    expect(rootAgent.json()).toMatchObject({
      status: "queued",
      candidateVersionId: expect.any(String),
      proposalId: expect.any(String),
      runId: expect.any(String)
    });
    const activeAgentAfterQueuedEdit = (
      await app.inject({ url: "/agent", headers: { cookie: rootAccessCookie } })
    ).json().agent;
    expect(activeAgentAfterQueuedEdit.ai_model).not.toBe("root/model");
    expect(activeAgentAfterQueuedEdit.openrouter_provider).not.toBe("openai");
    const versions = await app.inject({ url: "/agent/versions", headers: { cookie: rootAccessCookie } });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version_number: 2, source: "manual", status: "candidate", ai_model: "root/model" }),
      expect.objectContaining({ version_number: 1, source: "bootstrap", status: "active" })
    ]));
    expect((await pool.query(
      "SELECT count(*)::int count FROM audit_logs WHERE workspace_id=$1 AND action='agent.version.manual_candidate_created'",
      [rootCreatedTenant]
    )).rows[0].count).toBe(1);
    const disabledAgent = await app.inject({ method: "PATCH", url: "/agent/status", headers: { cookie: rootAccessCookie }, payload: { isActive: false } });
    expect(disabledAgent.statusCode).toBe(200);
    expect(disabledAgent.json().agent.is_active).toBe(false);
    const enabledAgent = await app.inject({ method: "PATCH", url: "/agent/status", headers: { cookie: rootAccessCookie }, payload: { isActive: true } });
    expect(enabledAgent.statusCode).toBe(200);
    expect(enabledAgent.json().agent.is_active).toBe(true);
    const currentHumanizer = await app.inject({ url: "/humanizer", headers: { cookie: rootAccessCookie } });
    expect(currentHumanizer.statusCode).toBe(200);
    const humanizer = currentHumanizer.json().humanizer;
    humanizer.composing.wpm = 181;
    const rootHumanizer = await app.inject({ method: "PUT", url: "/humanizer", headers: { cookie: rootAccessCookie }, payload: humanizer });
    expect(rootHumanizer.statusCode).toBe(200);
    expect(rootHumanizer.json().humanizer.composing.wpm).toBe(181);
    expect((await app.inject({ url: "/workspaces/current/audit-logs", headers: { cookie: rootAccessCookie } })).statusCode).toBe(200);

    const accepted = await app.inject({ method: "POST", url: "/auth/accept-invitation", payload: { token: created.json().token, newPassword: "initial-owner-password", passwordConfirmation: "initial-owner-password" } });
    expect(accepted.statusCode).toBe(200);
    const ownerCookie = (Array.isArray(accepted.headers["set-cookie"]) ? accepted.headers["set-cookie"][0] : accepted.headers["set-cookie"]!).split(";")[0];
    const me = await app.inject({ url: "/me", headers: { cookie: ownerCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().activeWorkspace).toMatchObject({ id: rootCreatedTenant, role: "OWNER" });
    const audit = await app.inject({ url: "/root/audit-logs", headers: { cookie: rootCookie } });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().auditLogs.map((row: { action: string }) => row.action)).toEqual(expect.arrayContaining(["root.workspaces.create", "root.owner.invite", "root.workspaces.update", "root.workspace.access"]));
    const createAudit = await pool.query<{ ip_address: string | null; user_agent: string | null }>(
      "SELECT ip_address,user_agent FROM audit_logs WHERE workspace_id=$1 AND action='root.workspaces.create' ORDER BY created_at DESC LIMIT 1",
      [rootCreatedTenant]
    );
    expect(createAudit.rows[0]).toMatchObject({ ip_address: expect.any(String), user_agent: "saas-foundation-test" });
  });

  it("lets ROOT use operational routes and audits destructive maintenance by workspace", async () => {
    const rootCookie = await login(rootEmail);
    expect((await app.inject({ url: "/dashboard", headers: { cookie: rootCookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/conversations", headers: { cookie: rootCookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/agent", headers: { cookie: rootCookie } })).statusCode).toBe(200);

    await pool.query(
      "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'reset-category','Reset category')",
      [tenantA]
    );
    await pool.query(
      "INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days) VALUES($1,'reset-unit','Reset unit','09:00','18:00',ARRAY[1,2,3,4,5]::smallint[])",
      [tenantA]
    );
    const lead = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,interest_category_id,unit_id,source)
       VALUES($1,'5511900000099','Lead reset','reset-category','reset-unit','ia') RETURNING id`,
      [tenantA]
    );
    const appointment = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at)
       VALUES($1,$2,'reset-unit','2030-01-07T09:00:00Z','2030-01-07T10:00:00Z') RETURNING id`,
      [lead.rows[0].id, tenantA]
    );

    const response = await app.inject({ method: "DELETE", url: `/root/workspaces/${tenantA}/contacts-and-messages`, headers: { cookie: rootCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().deleted).toMatchObject({ contacts: 1, messages: 1, leads: 2, appointments: 1 });
    expect((await pool.query("SELECT id FROM conversations WHERE id=$1", [conversationA])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM scheduling_leads WHERE id=$1", [lead.rows[0].id])).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM scheduling_appointments WHERE id=$1", [appointment.rows[0].id])).rowCount).toBe(0);
    const usage = await pool.query<{ conversation_id: string | null }>("SELECT conversation_id FROM usage_logs WHERE tenant_id=$1", [tenantA]);
    expect(usage.rows).toEqual([{ conversation_id: null }]);
    const audit = await pool.query(
      "SELECT action,actor_scope FROM audit_logs WHERE workspace_id=$1 AND action='root.dev.contacts_and_messages.delete'",
      [tenantA]
    );
    expect(audit.rows.map((row) => row.action)).toEqual(["root.dev.contacts_and_messages.delete"]);
    expect(audit.rows.every((row) => row.actor_scope === "root")).toBe(true);
  });
});
