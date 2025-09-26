import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";

/* ============== SUPABASE ============== */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

/* ============== TYPES ============== */
type Item = { name: string; threshold: number };
type Snapshot = {
  id: string;
  title?: string;
  dateISO: string; // Supabase created_at
  data: { areas: string[]; items: Item[]; quantities: number[][] };
};

/* ============== CONSTANTS ============== */
const STORAGE_KEY = "inventory_matrix_v2";
const SNAPSHOTS_CACHE_KEY = "inventory_snapshots_cache_v1";
const CLOUD_STATE_ID = "current"; // single-row document in inventory_state

/* ============== UTILS ============== */
const pad2 = (n: number) => String(n).padStart(2, "0");
const nowStamp = () => {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
  );
};
const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

function exportToXLSX(
  items: Item[],
  areas: string[],
  quantities: number[][],
  filename?: string
) {
  const header = ["Item", ...areas, "Total"];
  const rows = items.map((it, r) => {
    const total = (quantities[r] || []).reduce(
      (a, b) => a + (Number(b) || 0),
      0
    );
    return [it.name, ...areas.map((_, c) => quantities[r]?.[c] ?? 0), total];
  });
  const colTotals = areas.map((_, c) =>
    quantities.reduce((a, row) => a + (Number(row?.[c]) || 0), 0)
  );
  const grand = colTotals.reduce((a, b) => a + b, 0);
  const footer = ["TOTAL", ...colTotals, grand];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([header, ...rows, footer]),
    "Inventory"
  );

  const meta = [
    ["Date", new Date().toISOString()],
    ["Areas", areas.length],
    ["Items", items.length],
    ["Grand total", grand],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), "Meta");

  XLSX.writeFile(wb, filename || `inventory_${nowStamp()}.xlsx`);
}

/* ============== APP ============== */
export default function InventoryApp() {
  /* Main state (defaults first run only) */
  const [areas, setAreas] = useState<string[]>([
    "Kitchen",
    "Spa",
    "Front Desk",
    "Office",
  ]);
  const [items, setItems] = useState<Item[]>([
    { name: "Broom", threshold: 2 },
    { name: "Towels", threshold: 10 },
    { name: "Pencils", threshold: 5 },
  ]);
  const [quantities, setQuantities] = useState<number[][]>([
    [3, 5, 0, 0],
    [20, 40, 0, 0],
    [0, 0, 0, 15],
  ]);

  /* UI */
  const [q, setQ] = useState("");

  /* Snapshots */
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [viewSnap, setViewSnap] = useState<Snapshot | null>(null);
  const [loadingSnaps, setLoadingSnaps] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncTimer = useRef<number | null>(null);

  /* ---------- First load: try cloud state, fallback to local ---------- */
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("inventory_state")
        .select("data")
        .eq("id", CLOUD_STATE_ID)
        .single();

      if (!error && data?.data) {
        const cloud = data.data as {
          areas: string[];
          items: Item[];
          quantities: number[][];
        };
        setAreas(cloud.areas || []);
        setItems(cloud.items || []);
        setQuantities(cloud.quantities || []);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cloud));
      } else {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.areas && parsed?.items && parsed?.quantities) {
              setAreas(parsed.areas);
              setItems(parsed.items);
              setQuantities(parsed.quantities);
            }
          }
        } catch {}
      }
    })();
  }, []);

  /* ---------- Local backup ---------- */
  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ areas, items, quantities })
    );
  }, [areas, items, quantities]);

  /* ---------- Auto-sync to cloud on any change (debounced) ---------- */
  useEffect(() => {
    if (syncTimer.current) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(async () => {
      setSyncing(true);
      try {
        const { error } = await supabase.from("inventory_state").upsert(
          {
            id: CLOUD_STATE_ID,
            data: { areas, items, quantities },
          },
          { onConflict: "id" }
        );
        if (error) console.warn("Cloud sync error:", error);
      } finally {
        setSyncing(false);
      }
    }, 700);
  }, [areas, items, quantities]);

  /* ---------- Load snapshots ---------- */
  const refreshSnapshots = async () => {
    setLoadingSnaps(true);
    try {
      const { data, error } = await supabase
        .from("inventory_snapshots")
        .select("id, created_at, title, data")
        .order("created_at", { ascending: false })
        .limit(5);

      if (error) {
        alert("Could not refresh from Supabase. Showing local cache.");
        const raw = localStorage.getItem(SNAPSHOTS_CACHE_KEY);
        if (raw) setSnapshots(JSON.parse(raw));
        return;
      }
      const snaps: Snapshot[] = (data || []).map((row: any) => ({
        id: row.id,
        title: row.title ?? undefined,
        dateISO: row.created_at,
        data: row.data,
      }));
      setSnapshots(snaps);
      localStorage.setItem(SNAPSHOTS_CACHE_KEY, JSON.stringify(snaps));
    } finally {
      setLoadingSnaps(false);
    }
  };

  useEffect(() => {
    refreshSnapshots();
  }, []);

  /* ---------- Realtime: listen to changes in inventory_state.current ---------- */
  useEffect(() => {
    const channel = supabase
      .channel("inv-state")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "inventory_state",
          filter: "id=eq.current",
        },
        async () => {
          const { data, error } = await supabase
            .from("inventory_state")
            .select("data")
            .eq("id", CLOUD_STATE_ID)
            .single();

          if (!error && data?.data) {
            const cloud = data.data as {
              areas: string[];
              items: Item[];
              quantities: number[][];
            };
            setAreas(cloud.areas || []);
            setItems(cloud.items || []);
            setQuantities(cloud.quantities || []);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(cloud));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  /* ---------- Immediate cloud upsert helper ---------- */
  const upsertNow = async (next: {
    areas: string[];
    items: Item[];
    quantities: number[][];
  }) => {
    const { error } = await supabase
      .from("inventory_state")
      .upsert({ id: CLOUD_STATE_ID, data: next }, { onConflict: "id" });
    if (error) {
      console.warn("Immediate cloud upsert failed:", error);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  };

  /* Totals */
  const rowTotals = useMemo(
    () =>
      items.map(
        (_, r) =>
          (quantities[r] || []).reduce(
            (a: number, b: number) => a + (Number(b) || 0),
            0
          ),
        []
      ),
    [items, quantities]
  );
  const colTotals = useMemo(
    () =>
      areas.map((_, c) =>
        quantities.reduce((a, row) => a + (Number(row?.[c]) || 0), 0)
      ),
    [areas, quantities]
  );
  const grandTotal = useMemo(
    () => colTotals.reduce((a, b) => a + b, 0),
    [colTotals]
  );

  /* Filtering */
  const filteredIdx = useMemo(
    () =>
      items
        .map((it, idx) => ({ it, idx }))
        .filter(({ it }) => it.name.toLowerCase().includes(q.toLowerCase()))
        .map(({ idx }) => idx),
    [items, q]
  );

  /* Edit quantity */
  const setQty = (r: number, c: number, val: string) => {
    const n = Number(val) || 0;
    setQuantities((prev) => {
      const copy = prev.map((row) => row.slice());
      copy[r][c] = n;
      return copy;
    });
  };

  /* Add area (immediate upsert) */
  const addArea = async () => {
    const label = prompt("New area name:")?.trim();
    if (!label) return;
    if (areas.includes(label)) {
      alert("That area already exists.");
      return;
    }

    const nextAreas = [...areas, label];
    const nextQuantities = quantities.map((row) => [...row, 0]);

    setAreas(nextAreas);
    setQuantities(nextQuantities);

    await upsertNow({ areas: nextAreas, items, quantities: nextQuantities });
  };

  /* Add item (immediate upsert) */
  const addItem = async () => {
    const name = prompt("New item name:")?.trim();
    if (!name) return;
    if (items.some((it) => it.name.toLowerCase() === name.toLowerCase())) {
      alert("That item already exists.");
      return;
    }
    const threshold =
      Number(prompt("Low-stock threshold (optional):") || 0) || 0;

    const nextItems = [...items, { name, threshold }];
    const nextQuantities = [...quantities, Array(areas.length).fill(0)];

    setItems(nextItems);
    setQuantities(nextQuantities);

    await upsertNow({ areas, items: nextItems, quantities: nextQuantities });
  };

  /* Rename area (double click) */
  const renameArea = async (idx: number) => {
    const current = areas[idx];
    const label = prompt(`Rename area "${current}" to:`, current)?.trim();
    if (label === null || label === undefined) return;
    if (label === "") return alert("Name cannot be empty.");
    if (
      areas.some((a, i) => i !== idx && a.toLowerCase() === label.toLowerCase())
    ) {
      return alert("That area already exists.");
    }
    const nextAreas = areas.map((a, i) => (i === idx ? label : a));
    setAreas(nextAreas);
    await upsertNow({ areas: nextAreas, items, quantities });
  };

  /* Rename item (double click) */
  const renameItem = async (idx: number) => {
    const current = items[idx].name;
    const label = prompt(`Rename item "${current}" to:`, current)?.trim();
    if (label === null || label === undefined) return;
    if (label === "") return alert("Name cannot be empty.");
    if (
      items.some(
        (it, i) => i !== idx && it.name.toLowerCase() === label.toLowerCase()
      )
    ) {
      return alert("That item already exists.");
    }
    const nextItems = items.map((it, i) =>
      i === idx ? { ...it, name: label } : it
    );
    setItems(nextItems);
    await upsertNow({ areas, items: nextItems, quantities });
  };

  /* Ask destination area when deleting an area */
  const askReassignIndex = (sourceIdx: number): number | null => {
    if (areas.length <= 1) {
      const ok = confirm(
        `No other areas available. Delete "${areas[sourceIdx]}" and DISCARD its quantities?`
      );
      return ok ? -1 : null; // -1 discard, null cancel
    }
    const options = areas
      .map((a, i) => (i === sourceIdx ? null : `${i + 1}) ${a}`))
      .filter(Boolean)
      .join("\n");
    const ans = prompt(
      `You are deleting area "${areas[sourceIdx]}".\n` +
        `Options:\n${options}\n\n` +
        `Type the NUMBER of the destination area to REASSIGN its quantities.\n` +
        `Empty = DISCARD quantities.\n` +
        `Cancel = abort.`
    );
    if (ans === null) return null;
    const trimmed = ans.trim();
    if (trimmed === "") return -1; // discard
    const num = Number(trimmed);
    if (!Number.isInteger(num)) {
      alert("Invalid input.");
      return null;
    }
    const destIdx = num - 1;
    if (destIdx < 0 || destIdx >= areas.length || destIdx === sourceIdx) {
      alert("Out-of-range / invalid index.");
      return null;
    }
    return destIdx;
  };

  /* Remove area (immediate upsert) */
  const removeArea = async (c: number) => {
    const dest = askReassignIndex(c);
    if (dest === null) return; // canceled

    const nextAreas = areas.filter((_, i) => i !== c);
    const nextQuantities = quantities.map((row) => {
      const copy = row.slice();
      if (dest >= 0) {
        const moved = Number(copy[c]) || 0;
        if (moved !== 0) copy[dest] = (Number(copy[dest]) || 0) + moved;
      }
      copy.splice(c, 1);
      return copy;
    });

    setAreas(nextAreas);
    setQuantities(nextQuantities);

    await upsertNow({ areas: nextAreas, items, quantities: nextQuantities });
  };

  /* Remove item (immediate upsert) */
  const removeItem = async (r: number) => {
    if (!confirm(`Delete item "${items[r].name}"?`)) return;

    const nextItems = items.filter((_, i) => i !== r);
    const nextQuantities = quantities.filter((_, i) => i !== r);

    setItems(nextItems);
    setQuantities(nextQuantities);

    await upsertNow({ areas, items: nextItems, quantities: nextQuantities });
  };

  /* Save snapshot + Excel + Supabase
     - Also upserts the current state to inventory_state
  */
  const saveSnapshotAndExcel = async () => {
    const defaultTitle = new Date().toLocaleDateString();
    const titleInput = prompt(
      `Title/notes for this snapshot (Esc to cancel).\n` +
        `Leave empty to use today's date: ${defaultTitle}`,
      defaultTitle
    );
    if (titleInput === null) return;
    const finalTitle =
      titleInput.trim() === "" ? defaultTitle : titleInput.trim();

    // 0) Ensure cloud state is up-to-date right now (explicit save)
    setSyncing(true);
    const payload = { areas, items, quantities };
    const up = await supabase
      .from("inventory_state")
      .upsert({ id: CLOUD_STATE_ID, data: payload }, { onConflict: "id" });
    setSyncing(false);
    if (up.error) {
      alert("Could not save current state to Supabase: " + up.error.message);
      return;
    }

    // 1) Excel local
    exportToXLSX(items, areas, quantities, `inventory_${nowStamp()}.xlsx`);

    // 2) Snapshot (history)
    const { data, error } = await supabase
      .from("inventory_snapshots")
      .insert({ title: finalTitle, data: payload })
      .select("id, created_at, title, data")
      .single();

    if (error) {
      alert("Could not save snapshot in Supabase. Check RLS/keys.");
      return;
    }

    const snap: Snapshot = {
      id: data.id,
      title: data.title ?? undefined,
      dateISO: data.created_at,
      data: data.data,
    };

    setSnapshots((prev) => [snap, ...prev].slice(0, 5));
    localStorage.setItem(
      SNAPSHOTS_CACHE_KEY,
      JSON.stringify([snap, ...snapshots].slice(0, 5))
    );
    alert("Saved (state + snapshot) to Supabase and exported to Excel.");
  };

  /* Delete snapshot (with DELETE text confirmation) */
  const deleteSnapshot = async (s: Snapshot) => {
    const token = prompt(
      `To permanently delete this snapshot, type: DELETE\n\n` +
        `Snapshot: ${s.title ?? new Date(s.dateISO).toLocaleString()}`
    );
    if (token === null) return;
    if (token !== "DELETE") {
      alert("Deletion cancelled.");
      return;
    }

    const { error } = await supabase
      .from("inventory_snapshots")
      .delete()
      .eq("id", s.id);

    if (error) {
      alert("Could not delete snapshot in Supabase: " + error.message);
      return;
    }
    await refreshSnapshots();
    if (viewSnap?.id === s.id) setViewSnap(null);
  };

  /* View snapshot */
  const openSnapshot = (s: Snapshot) => setViewSnap(s);
  const closeSnapshot = () => setViewSnap(null);

  /* ============== UI ============== */
  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div>
          <h1 className="title">📦 Inventory</h1>
          <p className="subtitle">
            Edit quantities. Use 🗑️ to delete. Double-click names to rename.
            “Save” exports Excel and stores a snapshot in Supabase.
          </p>
        </div>

        {/* Actions */}
        <div className="toolbar">
          <input
            className="input"
            type="text"
            placeholder="Search item…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn" onClick={addArea}>
            + Area
          </button>
          <button className="btn" onClick={addItem}>
            + Item
          </button>
          <button className="btn btn-primary" onClick={saveSnapshotAndExcel}>
            Save (Excel + snapshot)
          </button>
          <span className="muted" style={{ marginLeft: 8 }}>
            {syncing ? "Syncing…" : "Synced"}
          </span>
        </div>
      </header>

      {/* Table */}
      <div className="table-wrapper" style={{ marginTop: 10 }}>
        <table className="table">
          <thead>
            <tr>
              <th>Item</th>
              {areas.map((a, c) => (
                <th key={c}>
                  <div className="th-flex">
                    <span
                      title="Double-click to rename area"
                      onDoubleClick={() => renameArea(c)}
                      style={{ cursor: "text" }}
                    >
                      {a}
                    </span>
                    <button
                      className="icon danger"
                      title={`Delete area "${a}"`}
                      onClick={() => removeArea(c)}
                    >
                      🗑️
                    </button>
                  </div>
                </th>
              ))}
              <th className="bg">Total</th>
              <th className="bg">⋯</th>
            </tr>
          </thead>
          <tbody>
            {filteredIdx.map((r) => (
              <tr key={r}>
                <td
                  className="cell-item"
                  title="Double-click to rename item"
                  onDoubleClick={() => renameItem(r)}
                  style={{ cursor: "text" }}
                >
                  {items[r].name}
                </td>
                {areas.map((_, c) => {
                  const val = quantities[r]?.[c] ?? 0;
                  const low =
                    (items[r].threshold ?? 0) > 0 && val < items[r].threshold;
                  return (
                    <td key={c} className={cx(low && "low")}>
                      <input
                        className="qty"
                        type="number"
                        min={0}
                        value={val}
                        onChange={(e) => setQty(r, c, e.target.value)}
                      />
                    </td>
                  );
                })}
                <td className="bg strong center">{rowTotals[r]}</td>
                <td className="center">
                  <button
                    className="icon danger"
                    title={`Delete item "${items[r].name}"`}
                    onClick={() => removeItem(r)}
                  >
                    🗑️
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="strong">TOTAL</td>
              {colTotals.map((t, i) => (
                <td key={i} className="bg strong center">
                  {t}
                </td>
              ))}
              <td className="bg strong center">{grandTotal}</td>
              <td className="bg" />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Snapshots list BELOW the table */}
      <section style={{ marginTop: 14 }}>
        <div className="card">
          <div className="card-title">Saved snapshots (last 5)</div>
          {loadingSnaps ? (
            <div className="muted">Loading…</div>
          ) : snapshots.length === 0 ? (
            <div className="muted">No snapshots yet.</div>
          ) : (
            <ul className="snap-list">
              {snapshots.slice(0, 5).map((s) => (
                <li key={s.id} className="snap-item">
                  <span className="truncate">
                    {s.title ?? new Date(s.dateISO).toLocaleString()}
                  </span>
                  <div className="actions">
                    <button
                      className="btn btn-outline"
                      onClick={() => openSnapshot(s)}
                    >
                      View
                    </button>
                    <button
                      className="btn btn-danger"
                      title="Delete snapshot"
                      onClick={() => deleteSnapshot(s)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Snapshot modal */}
      {viewSnap && (
        <div className="modal">
          <div className="modal-card">
            <div className="modal-head">
              <div className="strong">
                Snapshot: {new Date(viewSnap.dateISO).toLocaleString()}{" "}
                {viewSnap.title ? `— ${viewSnap.title}` : ""}
              </div>
              <div className="actions">
                <button className="btn" onClick={closeSnapshot}>
                  Close
                </button>
                <button
                  className="btn btn-danger"
                  title="Delete this snapshot"
                  onClick={() => deleteSnapshot(viewSnap)}
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    {viewSnap.data.areas.map((a, idx) => (
                      <th key={idx}>{a}</th>
                    ))}
                    <th className="bg">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {viewSnap.data.items.map((it, r) => {
                    const tot = (viewSnap.data.quantities[r] || []).reduce(
                      (a, b) => a + (Number(b) || 0),
                      0
                    );
                    return (
                      <tr key={r}>
                        <td className="cell-item">{it.name}</td>
                        {viewSnap.data.areas.map((_, c) => (
                          <td key={c} className="center">
                            {viewSnap.data.quantities[r]?.[c] ?? 0}
                          </td>
                        ))}
                        <td className="bg strong center">{tot}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="strong">TOTAL</td>
                    {viewSnap.data.areas.map((_, c) => {
                      const col = viewSnap.data.quantities.reduce(
                        (a, row) => a + (Number(row?.[c]) || 0),
                        0
                      );
                      return (
                        <td key={c} className="bg strong center">
                          {col}
                        </td>
                      );
                    })}
                    <td className="bg strong center">
                      {viewSnap.data.quantities
                        .flat()
                        .reduce((a, b) => a + (Number(b) || 0), 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
