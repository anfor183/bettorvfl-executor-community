// Strategy identity comes from recorded provenance, never probability or odds.
const labels = { safest: 'Safest', high_value: 'High Chance', ai_best: 'AI Best', high_risk: 'High-risk AI Picks', goals: 'Goals Engine', unknown: 'Unknown strategy' };
function strategyId(pick = {}) {
    if (pick.strategy_id && Object.hasOwn(labels, pick.strategy_id)) return pick.strategy_id;
    let metadata = {};
    try { metadata = typeof pick.predicted_probs === 'string' ? JSON.parse(pick.predicted_probs) : pick.predicted_probs || {}; } catch {}
    const engine = String(pick.engine || pick.engineMeta?.engine || metadata._engineMeta?.engine || '').toLowerCase();
    const version = String(pick.model_version || pick.modelVersion || pick.engineMeta?.modelVersion || metadata._engineMeta?.modelVersion || '');
    if (engine === 'ai_best' || version.startsWith('ai_best-')) return 'ai_best';
    const raw = String(pick.server_pick_type || pick.pick_type || pick.category || pick.tier || engine).toLowerCase();
    if (raw === 'ai_best_pick') return pick.record_source === 'ml_shadow' ? 'ai_best' : 'high_risk';
    const aliases = { ai_best: 'ai_best', ai_high_risk: 'high_risk', high_risk: 'high_risk', safest: 'safest', safe: 'safest', high_chance: 'high_value', high_value: 'high_value', goals: 'goals', goals_strategy: 'goals', goals_engine: 'goals' };
    return aliases[raw] || aliases[String(pick.category || '').toLowerCase()] || 'unknown';
}
function normalizeStrategy(pick) {
    if (!pick) return pick;
    const strategy_id = strategyId(pick);
    const pick_type = strategy_id === 'ai_best' ? 'ai_best_pick' : strategy_id === 'unknown' ? (pick.pick_type || 'unknown') : strategy_id;
    const category = ({ high_value: 'high_chance', goals: 'goals_strategy' })[strategy_id] || strategy_id;
    return { ...pick, server_pick_type: pick.server_pick_type || pick.pick_type || null, pick_type, strategy_id, category,
        category_label: labels[strategy_id], is_best_pick: strategy_id === 'ai_best' };
}
function matchesStrategy(pick, selection = 'all') {
    const id = strategyId(pick), selected = String(selection).toLowerCase();
    if (selected === 'all') return id !== 'unknown';
    const expected = ({ ai_best_pick: 'ai_best', ai_high_risk: 'high_risk', high_chance: 'high_value', goals_engine: 'goals', goals_strategy: 'goals' })[selected] || selected;
    return id === expected;
}

function normalizeTiers(tiers) {
    const all = ['safest','high_chance','high_risk','ai_best','goals_strategy'];
    if (!Array.isArray(tiers)) return all;
    const old = ['safest','high_chance','high_risk'];
    return tiers.length === 3 && old.every(id => tiers.includes(id)) ? all : tiers;
}

export { strategyId, normalizeStrategy, matchesStrategy, normalizeTiers, labels };
