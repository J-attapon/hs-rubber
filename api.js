(() => {
  'use strict';

  const cfg = window.RUBBER_CONFIG || {};
  if (!window.supabase) throw new Error('ไม่พบ Supabase JS library');

  const isConfigured = () =>
    cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY &&
    !String(cfg.SUPABASE_URL).includes('YOUR_PROJECT') &&
    !String(cfg.SUPABASE_PUBLISHABLE_KEY).includes('YOUR_SUPABASE');

  const db = isConfigured()
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      })
    : null;

  const emailFor = username => `${String(username || '').trim().toLowerCase()}@${cfg.AUTH_DOMAIN || 'rubber.local'}`;
  const err = e => new Error(e?.message || String(e || 'Unknown error'));

  function mustDb() {
    if (!db) throw new Error('ยังไม่ได้ตั้งค่า Supabase ใน config.js');
    return db;
  }

  async function sessionUser() {
    const c = mustDb();
    const { data: { session }, error } = await c.auth.getSession();
    if (error) throw err(error);
    if (!session?.user) throw new Error('SESSION_EXPIRED');
    return { session, authUser: session.user };
  }

  async function profile() {
    const c = mustDb();
    const { authUser } = await sessionUser();
    const { data, error } = await c
      .from('profiles')
      .select('id,username,display_name,role,active,last_login')
      .eq('id', authUser.id)
      .single();
    if (error) throw err(error);
    if (!data?.active) {
      await c.auth.signOut();
      throw new Error('SESSION_EXPIRED');
    }
    return {
      username: data.username,
      displayName: data.display_name || data.username,
      role: data.role,
      active: !!data.active,
      lastLogin: data.last_login || ''
    };
  }

  function normalizeDashboard(d) {
    if (!d) throw new Error('ไม่ได้รับข้อมูล Dashboard');
    return {
      date: d.date,
      grades: d.grades || cfg.GRADES || [],
      byGrade: d.byGrade || {},
      totalOpening: Number(d.totalOpening || 0),
      totalReceive: Number(d.totalReceive || 0),
      totalSale: Number(d.totalSale || 0),
      totalClosing: Number(d.totalClosing || 0),
      netToday: Number(d.netToday || 0),
      salePieces: Number(d.salePieces || 0),
      avgSalePerPiece: Number(d.avgSalePerPiece || 0),
      missingSalePiecesTransactions: Number(d.missingSalePiecesTransactions || 0),
      recent: d.recent || [],
      dayTransactions: d.dayTransactions || [],
      last7: d.last7 || [],
      monthly: d.monthly || []
    };
  }

  async function dashboard(date) {
    const c = mustDb();
    await sessionUser();
    const { data, error } = await c.rpc('dashboard_data', { p_date: date });
    if (error) throw err(error);
    return normalizeDashboard(data);
  }

  async function listUsers() {
    const me = await profile();
    if (me.role !== 'admin') return [];
    const c = mustDb();
    const { data, error } = await c
      .from('profiles')
      .select('username,display_name,role,active,last_login')
      .order('username');
    if (error) throw err(error);
    return (data || []).map(u => ({
      username: u.username,
      displayName: u.display_name || u.username,
      role: u.role,
      active: !!u.active,
      lastLogin: u.last_login || ''
    }));
  }

  async function bootstrap(date) {
    const me = await profile();
    const [dash, users] = await Promise.all([
      dashboard(date),
      me.role === 'admin' ? listUsers() : Promise.resolve([])
    ]);
    const { session } = await sessionUser();
    return {
      ok: true,
      token: session.access_token,
      user: me,
      version: cfg.VERSION || '7.0.0',
      grades: cfg.GRADES || [],
      dashboard: dash,
      users
    };
  }

  async function invokeAdmin(action, payload = {}) {
    const c = mustDb();
    const { data, error } = await c.functions.invoke('admin-users', {
      body: { action, ...payload }
    });
    if (error) throw err(error);
    if (!data?.ok) throw new Error(data?.error || 'Admin operation failed');
    return data;
  }

  const methods = {
    async loginBootstrap(username, password, date) {
      const c = mustDb();
      const { data, error } = await c.auth.signInWithPassword({
        email: emailFor(username),
        password: String(password || '')
      });
      if (error || !data?.user) throw new Error('Username หรือ Password ไม่ถูกต้อง');

      const { error: upErr } = await c
        .from('profiles')
        .update({ last_login: new Date().toISOString() })
        .eq('id', data.user.id);
      if (upErr) console.warn('last_login update:', upErr.message);
      return bootstrap(date);
    },

    async getBootstrapData(_token, date) {
      return bootstrap(date);
    },

    async logout() {
      const c = mustDb();
      await c.auth.signOut();
      return { ok: true };
    },

    async refreshDashboard(_token, date) {
      return { ok: true, dashboard: await dashboard(date) };
    },

    async saveTransaction(_token, p) {
      const c = mustDb();
      const x = {
        tx_date: p.date,
        tx_type: p.type,
        grade: String(p.grade),
        weight_kg: Number(p.weight),
        pieces: p.type === 'sale' ? Number(p.pieces) : null
      };
      if (!(x.weight_kg > 0)) throw new Error('กรุณาระบุน้ำหนัก');
      if (!['receive', 'sale'].includes(x.tx_type)) throw new Error('ประเภทรายการไม่ถูกต้อง');
      if (x.tx_type === 'sale' && (!Number.isInteger(x.pieces) || x.pieces <= 0)) {
        throw new Error('ขายยาง: กรุณาระบุจำนวนก้อนเป็นจำนวนเต็มมากกว่า 0');
      }

      let q;
      if (p.editId) {
        q = c.from('transactions').update(x).eq('id', p.editId).is('deleted_at', null);
      } else {
        q = c.from('transactions').insert({ id: p.requestId, ...x });
      }
      const { error } = await q;
      if (error) {
        if (String(error.code) === '23505') {
          // requestId ซ้ำ = เคยบันทึกแล้ว ป้องกัน double submit
        } else throw err(error);
      }
      return {
        ok: true,
        message: p.editId ? 'แก้ไขข้อมูลเรียบร้อย' : 'บันทึกข้อมูลเรียบร้อย',
        dashboard: await dashboard(p.date)
      };
    },

    async deleteTransaction(_token, id, date) {
      const c = mustDb();
      const { error } = await c
        .from('transactions')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .is('deleted_at', null);
      if (error) throw err(error);
      return { ok: true, message: 'ลบรายการเรียบร้อย', dashboard: await dashboard(date) };
    },

    async syncSummary() {
      await sessionUser();
      return { ok: true, message: 'V7 คำนวณสรุปจาก PostgreSQL อัตโนมัติ ไม่ต้อง Sync ชีต' };
    },

    async saveUser(_token, p) {
      const r = await invokeAdmin('saveUser', { user: p });
      return { ok: true, message: r.message || 'บันทึกผู้ใช้เรียบร้อย', users: await listUsers() };
    },

    async resetUserPassword(_token, username, password) {
      const r = await invokeAdmin('resetPassword', { username, password });
      return { ok: true, message: r.message || 'Reset Password เรียบร้อย' };
    },

    async changeMyPassword(_token, currentPwd, newPwd) {
      if (String(newPwd || '').length < 8) throw new Error('Password ต้องอย่างน้อย 8 ตัวอักษร');
      const me = await profile();
      const c = mustDb();
      const { error: authErr } = await c.auth.signInWithPassword({
        email: emailFor(me.username),
        password: String(currentPwd || '')
      });
      if (authErr) throw new Error('รหัสผ่านปัจจุบันไม่ถูกต้อง');
      const { error } = await c.auth.updateUser({ password: String(newPwd) });
      if (error) throw err(error);
      return { ok: true, message: 'เปลี่ยนรหัสผ่านแล้ว กรุณา Login ใหม่' };
    }
  };

  window.RubberAPI = {
    client: db,
    async call(name, ...args) {
      if (!methods[name]) throw new Error(`ไม่รองรับคำสั่ง ${name}`);
      return methods[name](...args);
    }
  };
})();
