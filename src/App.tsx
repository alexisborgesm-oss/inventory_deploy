// src/App.tsx
import React, { useEffect, useMemo, useState } from "react";
import "./styles.css";
import { supabase } from "./supabase";

/* =============== Types =============== */
type Item = { name: string; threshold: number };
type InventoryState = {
  areas: string[];
  items: Item[];
  quantities: number[][]; // items x areas
};
type AreaRecord = {
  id: string;
  area_name: string;
  area_index: number;
  inventory_date: string; // ISO date (YYYY-MM-DD)
  items: { name: string; qty: number }[];
  created_at: string;
};

/* =============== Helpers =============== */
const pad2 = (n: number) => String(n).padStart(2, "0");
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const STATE_ID = "main";

/* =============== Supabase helpers =============== */
async function loadState(): Promise<InventoryState | null> {
  const { data, error } = await supabase
    .from("inventory_state")
    .select("data")
    .eq("id", STATE_ID)
    .maybeSingle();
  if (error) {
    console.warn("loadState error", error);
    return null;
  }
  return data?.data ?? null;
}

async function saveState(newState: InventoryState) {
  const { error } = await supabase
    .from("inventory_state")
    .upsert({ id: STATE_ID, data: newState }, { onConflict: "id" });
  if (error) throw error;
}

async function insertAreaRecord(rec: Omit<AreaRecord, "id" | "created_at">) {
  const { error } = await supabase.from("area_inventories").insert({
    area_name: rec.area_name,
    area_index: rec.area_index,
    inventory_date: rec.inventory_date,
    items: rec.items,
  });
  if (error) throw error;
}

async function fetchAreaRecords(limit = 20): Promise<AreaRecord[]> {
  const { data, error } = await supabase
    .from("area_inventories")
    .select("id, area_name, area_index, inventory_date, items, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data as any;
}

async function deleteAreaRecord(id: string) {
  const { error } = await supabase.from("area_inventories").delete().eq("id", id);
  if (error) throw error;
}

/* =============== App =============== */
type Tab = "area" | "matrix" | "records" | "catalog";

export default function App() {
  const [tab, setTab] = useState<Tab>("area");

  const [areas, setAreas] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [quantities, setQuantities] = useState<number[][]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Records (area_inventories)
  const [records, setRecords] = useState<AreaRecord[]>([]);
  const [recLoading, setRecLoading] = useState(false);
  // Modal detail
  const [recordDetail, setRecordDetail] = useState<AreaRecord | null>(null);

  /* ------------ Initial load ------------ */
  useEffect(() => {
    (async () => {
      setLoading(true);
      const remote = await loadState();
      if (remote) {
        setAreas(remote.areas);
        setItems(remote.items);
        setQuantities(remote.quantities);
      } else {
        // seed inicial si no hay nada en la base
        const seed: InventoryState = {
          areas: ["Kitchen", "Spa", "Front desk", "Office"],
          items: [
            { name: "Broom", threshold: 2 },
            { name: "Towels", threshold: 10 },
            { name: "Pencils", threshold: 5 },
          ],
          quantities: [
            [3, 5, 0, 0],
            [20, 40, 0, 0],
            [0, 0, 0, 15],
          ],
        };
        setAreas(seed.areas);
        setItems(seed.items);
        setQuantities(seed.quantities);
        try {
          await saveState(seed);
        } catch (e) {
          console.warn("Could not seed state:", e);
        }
      }
      setLoading(false);
    })();
  }, []);

  /* ------------ Load records list ------------ */
  const refreshRecords = async () => {
    setRecLoading(true);
    try {
      const data = await fetchAreaRecords(20);
      setRecords(data);
    } catch (e) {
      console.warn("fetchAreaRecords error", e);
    } finally {
      setRecLoading(false);
    }
  };
  useEffect(() => {
    refreshRecords();
  }, []);

  /* ------------ Totals ------------ */
  const colTotals = useMemo(
    () =>
      areas.map((_, c) =>
        quantities.reduce((a, row) => a + (Number(row?.[c]) || 0), 0)
      ),
    [areas, quantities]
  );
  const rowTotals = useMemo(
    () =>
      items.map((_, r) =>
        (quantities[r] || []).reduce((a, b) => a + (Number(b) || 0), 0)
      ),
    [items, quantities]
  );
  const grand = useMemo(() => colTotals.reduce((a, b) => a + b, 0), [colTotals]);

  /* =========================================================
     VIEW 1: AREA INVENTORY (principal)
     ========================================================= */
  const [areaIdx, setAreaIdx] = useState(0);
  const [filter, setFilter] = useState("");
  const [dateISO, setDateISO] = useState<string>(todayISO());

  const visibleRows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items.map((_, i) => i);
    return items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.name.toLowerCase().includes(q))
      .map(({ i }) => i);
  }, [items, filter]);

  const setQtyCell = (r: number, c: number, value: number) => {
    setQuantities((prev) => {
      const cp = prev.map((row) => row.slice());
      cp[r][c] = value;
      return cp;
    });
  };

  const saveAreaInventory = async () => {
    if (!areas[areaIdx]) return alert("Choose an area.");
    if (!dateISO) return alert("Pick a date.");

    // 1) Actualizar estado global (quantities de esa área)
    const stateToSave: InventoryState = {
      areas: [...areas],
      items: [...items],
      quantities: quantities.map((row) => row.slice()),
    };
    setSaving(true);
    try {
      await saveState(stateToSave);

      // 2) Insertar registro histórico del área con fecha
      const payload = items.map((it, r) => ({
        name: it.name,
        qty: Number(stateToSave.quantities[r]?.[areaIdx] ?? 0),
      }));
      await insertAreaRecord({
        area_name: areas[areaIdx],
        area_index: areaIdx,
        inventory_date: dateISO, // YYYY-MM-DD
        items: payload,
      });

      // 3) Refrescar records para que se vea en la vista 3
      await refreshRecords();

      alert(`Saved inventory for "${areas[areaIdx]}" (date: ${dateISO}).`);
    } catch (e: any) {
      alert("Could not save. Check Supabase credentials/RLS.");
      console.warn(e);
    } finally {
      setSaving(false);
    }
  };

  /* =========================================================
     VIEW 2: MATRIX (sin botones de crear)
     ========================================================= */
  const persist = async (ns: InventoryState) => {
    setSaving(true);
    try {
      await saveState(ns);
    } finally {
      setSaving(false);
    }
  };

  const removeArea = async (c: number) => {
    if (!confirm(`Delete area "${areas[c]}"? Quantities will be discarded.`))
      return;
    const ns: InventoryState = {
      areas: areas.filter((_, i) => i !== c),
      items: [...items],
      quantities: quantities.map((row) => {
        const clone = row.slice();
        clone.splice(c, 1);
        return clone;
      }),
    };
    setAreas(ns.areas);
    setQuantities(ns.quantities);
    await persist(ns);
  };

  const removeItem = async (r: number) => {
    if (!confirm(`Delete item "${items[r].name}"?`)) return;
    const ns: InventoryState = {
      areas: [...areas],
      items: items.filter((_, i) => i !== r),
      quantities: quantities.filter((_, i) => i !== r),
    };
    setItems(ns.items);
    setQuantities(ns.quantities);
    await persist(ns);
  };

  /* =========================================================
     VIEW 3: RECORDS (by Area)
     ========================================================= */
  const deleteRecord = async (id: string) => {
    if (!confirm("Delete this record?")) return;
    try {
      await deleteAreaRecord(id);
      setRecords((rs) => rs.filter((x) => x.id !== id));
      if (recordDetail?.id === id) setRecordDetail(null);
    } catch (e) {
      alert("Could not delete record.");
    }
  };

  /* =========================================================
     VIEW 4: CATALOG (Áreas & Ítems)
     ========================================================= */
  const [newArea, setNewArea] = useState("");
  const [newItem, setNewItem] = useState("");
  const [newItemTh, setNewItemTh] = useState<number>(0);

  const addArea = async () => {
    const name = newArea.trim();
    if (!name) return alert("Area name is required.");
    if (areas.includes(name)) return alert("Area already exists.");
    const ns: InventoryState = {
      areas: [...areas, name],
      items: [...items],
      quantities: quantities.map((row) => [...row, 0]),
    };
    setAreas(ns.areas);
    setQuantities(ns.quantities);
    setNewArea("");
    await persist(ns);
  };

  const addItem = async () => {
    const name = newItem.trim();
    if (!name) return alert("Item name is required.");
    if (items.some((it) => it.name.toLowerCase() === name.toLowerCase()))
      return alert("Item already exists.");
    const th = Number(newItemTh) || 0;
    const ns: InventoryState = {
      areas: [...areas],
      items: [...items, { name, threshold: th }],
      quantities: [...quantities, Array(areas.length).fill(0)],
    };
    setItems(ns.items);
    setQuantities(ns.quantities);
    setNewItem("");
    setNewItemTh(0);
    await persist(ns);
  };

  const renameArea = async (idx: number) => {
    const current = areas[idx];
    const next = prompt(`Rename area "${current}" to:`, current)?.trim();
    if (!next || next === current) return;
    if (areas.includes(next)) return alert("Area name already in use.");
    const ns: InventoryState = {
      areas: areas.map((a, i) => (i === idx ? next : a)),
      items: [...items],
      quantities: quantities.map((row) => row.slice()),
    };
    setAreas(ns.areas);
    await persist(ns);
  };

  const renameItem = async (idx: number) => {
    const current = items[idx].name;
    const next = prompt(`Rename item "${current}" to:`, current)?.trim();
    if (!next || next === current) return;
    if (items.some((it, i) => i !== idx && it.name.toLowerCase() === next.toLowerCase()))
      return alert("Item name already in use.");
    const ns: InventoryState = {
      areas: [...areas],
      items: items.map((it, i) => (i === idx ? { ...it, name: next } : it)),
      quantities: quantities.map((row) => row.slice()),
    };
    setItems(ns.items);
    await persist(ns);
  };

  /* ===================== UI ===================== */
  if (loading) {
    return (
      <div className="container center" style={{ height: "100dvh" }}>
        <div className="card" style={{ padding: 24, minWidth: 260, textAlign: "center" }}>
          <div className="badge">Loading inventory…</div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Navbar */}
      <div className="navbar">
        <div className="brand">
          <i>📦</i> Inventory
          <span className="badge">{saving ? "Saving…" : "Synced"}</span>
        </div>
        <div className="tabbar">
          <button
            className={`tab ${tab === "area" ? "active" : ""}`}
            onClick={() => setTab("area")}
          >
            Area Inventory
          </button>
          <button
            className={`tab ${tab === "matrix" ? "active" : ""}`}
            onClick={() => setTab("matrix")}
          >
            Matrix
          </button>
          <button
            className={`tab ${tab === "records" ? "active" : ""}`}
            onClick={() => setTab("records")}
          >
            Records (by Area)
          </button>
          <button
            className={`tab ${tab === "catalog" ? "active" : ""}`}
            onClick={() => setTab("catalog")}
          >
            Catalog
          </button>
        </div>
      </div>

      <div className="container" style={{ paddingTop: 18 }}>
        {/* =============== VIEW 1: AREA INVENTORY =============== */}
        {tab === "area" && (
          <div className="card" style={{ padding: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="row">
                <select
                  className="select"
                  value={areaIdx}
                  onChange={(e) => setAreaIdx(Number(e.target.value))}
                >
                  {areas.map((a, i) => (
                    <option key={i} value={i}>
                      {a}
                    </option>
                  ))}
                </select>
                <input
                  className="input"
                  type="date"
                  value={dateISO}
                  onChange={(e) => setDateISO(e.target.value)}
                  max={todayISO()}
                  title="Inventory date"
                />
                <input
                  className="input"
                  placeholder="Search item…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <div className="row">
                <button className="btn accent" onClick={saveAreaInventory}>
                  Save inventory for this area
                </button>
              </div>
            </div>

            <div className="hr" />
            <div className="card" style={{ padding: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Item</th>
                    <th>Quantity — {areas[areaIdx]}</th>
                    <th>Total (row)</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const v = quantities[r]?.[areaIdx] ?? 0;
                    const isLow = items[r].threshold > 0 && v < items[r].threshold;
                    const rowTot = rowTotals[r];
                    return (
                      <tr key={r}>
                        <td style={{ textAlign: "left" }}>{items[r].name}</td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            className="input number"
                            style={isLow ? { borderColor: "#5a2b2b", background: "#1a1319" } : undefined}
                            value={v}
                            onChange={(e) =>
                              setQtyCell(r, areaIdx, Number(e.target.value) || 0)
                            }
                          />
                        </td>
                        <td>{rowTot}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* =============== VIEW 2: MATRIX (sin crear) =============== */}
        {tab === "matrix" && (
          <div className="card" style={{ padding: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="badge">Edit numbers in place. Use Catalog to add new areas/items.</div>
            </div>

            <div className="hr" />

            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Item</th>
                    {areas.map((a, c) => (
                      <th key={c}>
                        <div className="row" style={{ justifyContent: "center", gap: 8 }}>
                          <span>{a}</span>
                          <button
                            className="btn danger"
                            onClick={() => removeArea(c)}
                            title={`Delete ${a}`}
                          >
                            🗑️
                          </button>
                        </div>
                      </th>
                    ))}
                    <th>Total</th>
                    <th>⋯</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, r) => (
                    <tr key={r}>
                      <td style={{ textAlign: "left" }}>{it.name}</td>
                      {areas.map((_, c) => (
                        <td key={c}>
                          <input
                            type="number"
                            min={0}
                            className="input number"
                            value={quantities[r]?.[c] ?? 0}
                            onChange={(e) => {
                              const n = Number(e.target.value) || 0;
                              setQuantities((prev) => {
                                const cp = prev.map((row) => row.slice());
                                cp[r][c] = n;
                                return cp;
                              });
                            }}
                            onBlur={() =>
                              persist({
                                areas: [...areas],
                                items: [...items],
                                quantities: quantities.map((row) => row.slice()),
                              })
                            }
                          />
                        </td>
                      ))}
                      <td>{rowTotals[r]}</td>
                      <td>
                        <button
                          className="btn danger"
                          onClick={() => removeItem(r)}
                          title={`Delete ${it.name}`}
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td style={{ textAlign: "left", fontWeight: 700 }}>TOTAL</td>
                    {colTotals.map((t, i) => (
                      <td key={i} style={{ fontWeight: 700 }}>
                        {t}
                      </td>
                    ))}
                    <td style={{ fontWeight: 800 }}>{grand}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* =============== VIEW 3: RECORDS (by Area) =============== */}
        {tab === "records" && (
          <div className="card" style={{ padding: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="brand" style={{ gap: 8 }}>
                <i>🗂️</i> Records (by Area)
              </div>
              <div className="row">
                <button className="btn" onClick={refreshRecords}>
                  Refresh
                </button>
              </div>
            </div>

            <div className="hr" />

            {recLoading ? (
              <div className="badge">Loading…</div>
            ) : records.length === 0 ? (
              <div className="muted">No records yet.</div>
            ) : (
              <div className="stack">
                {records.map((r) => (
                  <div key={r.id} className="card" style={{ padding: 12 }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>
                          {r.area_name} — {r.inventory_date}
                        </div>
                        <div className="muted">
                          Items saved: {(r.items as any[])?.length ?? 0}
                        </div>
                      </div>
                      <div className="row">
                        <button className="btn" onClick={() => setRecordDetail(r)}>
                          View
                        </button>
                        <button className="btn danger" onClick={() => deleteRecord(r.id)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* =============== VIEW 4: CATALOG (Áreas & Ítems) =============== */}
        {tab === "catalog" && (
          <div className="card" style={{ padding: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="brand" style={{ gap: 8 }}>
                <i>🗃️</i> Catalog
              </div>
              <div className="badge">These lists feed Area Inventory & Matrix</div>
            </div>

            <div className="hr" />

            <div className="stack">
              {/* AREAS */}
              <div className="card" style={{ padding: 14 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 700 }}>Areas</div>
                  <div className="row">
                    <input
                      className="input"
                      placeholder="New area name…"
                      value={newArea}
                      onChange={(e) => setNewArea(e.target.value)}
                    />
                    <button className="btn accent" onClick={addArea}>
                      + Add Area
                    </button>
                  </div>
                </div>

                <div className="hr" />
                {areas.length === 0 ? (
                  <div className="muted">No areas yet.</div>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    {areas.map((a, i) => (
                      <div
                        key={i}
                        className="row"
                        style={{
                          justifyContent: "space-between",
                          border: "1px solid var(--border)",
                          padding: "8px 10px",
                          borderRadius: 10,
                          background: "#0f1629",
                        }}
                      >
                        <div>{a}</div>
                        <div className="row">
                          <button className="btn" onClick={() => renameArea(i)}>
                            Rename
                          </button>
                          <button className="btn danger" onClick={() => removeArea(i)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* ITEMS */}
              <div className="card" style={{ padding: 14 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 700 }}>Items</div>
                  <div className="row" style={{ gap: 8 }}>
                    <input
                      className="input"
                      placeholder="New item name…"
                      value={newItem}
                      onChange={(e) => setNewItem(e.target.value)}
                      style={{ minWidth: 160 }}
                    />
                    <input
                      type="number"
                      min={0}
                      className="input"
                      placeholder="Threshold"
                      value={newItemTh}
                      onChange={(e) => setNewItemTh(Number(e.target.value) || 0)}
                      style={{ width: 120 }}
                      title="Low stock threshold (optional)"
                    />
                    <button className="btn accent" onClick={addItem}>
                      + Add Item
                    </button>
                  </div>
                </div>

                <div className="hr" />
                {items.length === 0 ? (
                  <div className="muted">No items yet.</div>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    {items.map((it, i) => (
                      <div
                        key={i}
                        className="row"
                        style={{
                          justifyContent: "space-between",
                          border: "1px solid var(--border)",
                          padding: "8px 10px",
                          borderRadius: 10,
                          background: "#0f1629",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600 }}>{it.name}</div>
                          <div className="muted">Threshold: {it.threshold || 0}</div>
                        </div>
                        <div className="row">
                          <button className="btn" onClick={() => renameItem(i)}>
                            Rename
                          </button>
                          <button className="btn danger" onClick={() => removeItem(i)}>
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ===== Record Detail Modal ===== */}
        {recordDetail && (
          <div className="modal-backdrop" onClick={() => setRecordDetail(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <div className="brand" style={{ gap: 8 }}>
                  <i>🗂️</i>
                  <span>
                    {recordDetail.area_name} — {recordDetail.inventory_date}
                  </span>
                </div>
                <button className="btn" onClick={() => setRecordDetail(null)}>
                  Close
                </button>
              </div>
              <div className="modal-body">
                <div className="badge" style={{ marginBottom: 8 }}>
                  Items in this record
                </div>
                <div className="card" style={{ padding: 10 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left" }}>Item</th>
                        <th>Quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recordDetail.items.map((it, i) => (
                        <tr key={i}>
                          <td style={{ textAlign: "left" }}>{it.name}</td>
                          <td>{Number(it.qty) || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td style={{ textAlign: "left", fontWeight: 700 }}>TOTAL</td>
                        <td style={{ fontWeight: 800 }}>
                          {recordDetail.items.reduce((a, b) => a + (Number(b.qty) || 0), 0)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="muted" style={{ marginTop: 10 }}>
                  Saved at: {new Date(recordDetail.created_at).toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
