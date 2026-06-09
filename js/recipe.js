/* recipe.js — RecipeManager: recording, fingerprint matching, import/export */

class RecipeManager {
  constructor(app) {
    this.app = app;
  }

  /* ---- Create recipe from current rules + dataset ---- */

  createRecipeFromRules(name, rules, dataset) {
    const fingerprints = this._buildFingerprints(dataset);
    const steps = rules.map((rule, i) => ({
      stepId: uid(),
      order: i,
      rule: deepClone(rule),
      columnRefs: this._extractColumnRefs(rule),
      description: this._stepDescription(rule)
    }));

    return {
      id: uid(),
      name: name,
      description: '',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourceInfo: {
        fileName: dataset.fileName || dataset.name || '',
        rowCount: dataset.rows.length,
        columnCount: dataset.headers.length
      },
      columnFingerprints: fingerprints,
      steps: steps
    };
  }

  _buildFingerprints(dataset) {
    if (!dataset.profile || !dataset.profile.profiles) return [];
    return dataset.profile.profiles.map((p, i) => ({
      name: p.column,
      index: i,
      detectedType: p.type,
      typeConfidence: p.typeConfidence,
      nullRate: p.nullRate,
      isEnum: p.isEnum || false,
      enumValues: p.enumValues ? p.enumValues.slice(0, 10).map(e => e.value) : null,
      sampleValues: (p.sampleValues || []).slice(0, 5),
      uniqueRatio: (p.validCount + p.dirtyCount) > 0
        ? p.uniqueCount / (p.validCount + p.dirtyCount) : 0
    }));
  }

  /* ---- Column reference extraction ---- */

  _extractColumnRefs(rule) {
    const refs = [];
    if (rule.column) refs.push(rule.column);
    if (rule.columns && Array.isArray(rule.columns)) refs.push(...rule.columns);
    if (rule.thisColumn) refs.push(rule.thisColumn);
    if (rule.mapping && typeof rule.mapping === 'object') {
      refs.push(...Object.keys(rule.mapping));
    }
    return [...new Set(refs)];
  }

  _stepDescription(rule) {
    const meta = RULE_META[rule.type];
    const label = meta ? meta.label : rule.type;
    switch (rule.type) {
      case 'dedup': return `${label}: 按${rule.columns ? rule.columns.join(', ') : '全部列'}去重`;
      case 'nullFill': return `${label}: ${rule.column} (${rule.method})`;
      case 'trim': return label;
      case 'fieldSplit': return `${label}: ${rule.column} 按 "${rule.delimiter}" 拆分`;
      case 'dateNormalize': return `${label}: ${rule.column} -> ${rule.outputFormat}`;
      case 'amountConvert': return `${label}: ${rule.column} x${rule.factor}`;
      case 'enumMap': return `${label}: ${rule.column} (${Object.keys(rule.mapping || {}).length} 个映射)`;
      case 'crossValidate': return `${label}: ${rule.thisColumn} <-> ${rule.otherDataset}.${rule.otherColumn}`;
      case 'rename': return `${label}: ${Object.keys(rule.mapping || {}).length} 个字段`;
      default: return rule.name || label;
    }
  }

  /* ============================================================
     Fingerprint Matching — 4-phase algorithm
     ============================================================ */

  matchFingerprints(recipe, targetDataset) {
    if (!targetDataset.profile || !targetDataset.profile.profiles) return [];

    const targetProfiles = targetDataset.profile.profiles;
    const recipeFPs = recipe.columnFingerprints;
    const results = [];

    const matchedTargets = new Set();
    const unmatchedRecipe = [];

    // Phase 1: Exact name match
    for (const fp of recipeFPs) {
      const exact = targetProfiles.find(
        (tp, i) => !matchedTargets.has(i) && tp.column === fp.name
      );
      if (exact) {
        const idx = targetProfiles.indexOf(exact);
        matchedTargets.add(idx);
        const conflicts = this._detectConflicts(fp, exact);
        results.push({
          recipeColName: fp.name,
          matchedColName: exact.column,
          matchType: 'exact',
          confidence: 100,
          alternatives: [],
          conflicts: conflicts
        });
      } else {
        unmatchedRecipe.push(fp);
      }
    }

    // Phase 2: Fuzzy name + type matching
    const stillUnmatched = [];
    for (const fp of unmatchedRecipe) {
      const candidates = [];
      for (let i = 0; i < targetProfiles.length; i++) {
        if (matchedTargets.has(i)) continue;
        const tp = targetProfiles[i];
        const score = this._computeMatchScore(fp, tp);
        if (score >= 0.35) {
          candidates.push({ colName: tp.column, colIdx: i, confidence: Math.round(score * 100), score, reason: this._matchReason(fp, tp) });
        }
      }
      candidates.sort((a, b) => b.score - a.score);

      if (candidates.length > 0 && candidates[0].score >= 0.7) {
        const isAmbiguous = candidates.length > 1 &&
          (candidates[0].score - candidates[1].score) < 0.15;

        if (isAmbiguous) {
          results.push({
            recipeColName: fp.name,
            matchedColName: candidates[0].colName,
            matchType: 'ambiguous',
            confidence: candidates[0].confidence,
            alternatives: candidates.slice(0, 4),
            conflicts: this._detectConflicts(fp, targetProfiles[candidates[0].colIdx])
          });
          matchedTargets.add(candidates[0].colIdx);
        } else {
          const best = candidates[0];
          matchedTargets.add(best.colIdx);
          const matchType = this._nameSimilarity(fp.name, targetProfiles[best.colIdx].column) > 0.6
            ? 'fuzzy_name' : 'type_match';
          results.push({
            recipeColName: fp.name,
            matchedColName: best.colName,
            matchType: matchType,
            confidence: best.confidence,
            alternatives: candidates.slice(1, 4),
            conflicts: this._detectConflicts(fp, targetProfiles[best.colIdx])
          });
        }
      } else {
        stillUnmatched.push({ fp, candidates });
      }
    }

    // Phase 3 & 4: Conflict detection on remaining + mark missing
    for (const { fp, candidates } of stillUnmatched) {
      results.push({
        recipeColName: fp.name,
        matchedColName: null,
        matchType: 'missing',
        confidence: 0,
        alternatives: candidates.slice(0, 4),
        conflicts: [{ type: 'missing_column', detail: `配方列 "${fp.name}" 在目标数据集中未找到匹配` }]
      });
    }

    return results;
  }

  _computeMatchScore(recipeFP, targetProfile) {
    const nameScore = this._nameSimilarity(recipeFP.name, targetProfile.column);
    const typeScore = this._typeSimilarity(recipeFP.detectedType, targetProfile.type);
    const distScore = this._distributionSimilarity(recipeFP, targetProfile);
    return nameScore * 0.4 + typeScore * 0.3 + distScore * 0.3;
  }

  _nameSimilarity(a, b) {
    if (!a || !b) return 0;
    const na = a.toLowerCase().replace(/[-_\s]/g, '');
    const nb = b.toLowerCase().replace(/[-_\s]/g, '');
    if (na === nb) return 1.0;
    if (na.includes(nb) || nb.includes(na)) return 0.8;
    // Levenshtein-based
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return 1.0;
    return 1 - this._levenshtein(na, nb) / maxLen;
  }

  _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => {
      const row = new Array(n + 1);
      row[0] = i;
      return row;
    });
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  _typeSimilarity(typeA, typeB) {
    if (typeA === typeB) return 1.0;
    const compatible = {
      integer: ['float', 'money', 'mixed'],
      float: ['integer', 'money', 'mixed'],
      money: ['integer', 'float', 'mixed'],
      string: ['mixed'],
      mixed: ['integer', 'float', 'money', 'string', 'date']
    };
    if (compatible[typeA] && compatible[typeA].includes(typeB)) return 0.5;
    return 0;
  }

  _distributionSimilarity(recipeFP, targetProfile) {
    let score = 0, count = 0;

    // Null rate similarity
    const nullRateA = recipeFP.nullRate || 0;
    const nullRateB = targetProfile.nullRate || 0;
    score += 1 - Math.abs(nullRateA - nullRateB) / 100;
    count++;

    // Unique ratio similarity
    const urA = recipeFP.uniqueRatio || 0;
    const nonNull = (targetProfile.validCount || 0) + (targetProfile.dirtyCount || 0);
    const urB = nonNull > 0 ? (targetProfile.uniqueCount || 0) / nonNull : 0;
    score += 1 - Math.abs(urA - urB);
    count++;

    // Enum overlap (Jaccard)
    if (recipeFP.isEnum && targetProfile.isEnum && recipeFP.enumValues && targetProfile.enumValues) {
      const setA = new Set(recipeFP.enumValues);
      const targetEnums = targetProfile.enumValues.map(e => typeof e === 'object' ? e.value : e);
      const setB = new Set(targetEnums);
      const intersection = [...setA].filter(v => setB.has(v)).length;
      const union = new Set([...setA, ...setB]).size;
      score += union > 0 ? intersection / union : 0;
      count++;
    }

    return count > 0 ? score / count : 0;
  }

  _matchReason(recipeFP, targetProfile) {
    const parts = [];
    const ns = this._nameSimilarity(recipeFP.name, targetProfile.column);
    if (ns >= 0.8) parts.push('名称匹配');
    else if (ns >= 0.5) parts.push('名称相似');
    if (recipeFP.detectedType === targetProfile.type) parts.push('类型相同');
    return parts.join(', ') || '分布相似';
  }

  _detectConflicts(recipeFP, targetProfile) {
    const conflicts = [];
    if (recipeFP.detectedType !== targetProfile.type) {
      conflicts.push({
        type: 'type_mismatch',
        detail: `类型不同: 配方 "${recipeFP.detectedType}" vs 目标 "${targetProfile.type}"`
      });
    }
    const nullDiff = Math.abs((recipeFP.nullRate || 0) - (targetProfile.nullRate || 0));
    if (nullDiff > 30) {
      conflicts.push({
        type: 'null_rate_divergence',
        detail: `空值率差异 ${nullDiff}%: 配方 ${recipeFP.nullRate}% vs 目标 ${targetProfile.nullRate}%`
      });
    }
    if (recipeFP.isEnum && targetProfile.isEnum && recipeFP.enumValues && targetProfile.enumValues) {
      const setA = new Set(recipeFP.enumValues);
      const targetEnums = targetProfile.enumValues.map(e => typeof e === 'object' ? e.value : e);
      const setB = new Set(targetEnums);
      const intersection = [...setA].filter(v => setB.has(v)).length;
      const union = new Set([...setA, ...setB]).size;
      if (union > 0 && intersection / union < 0.5) {
        conflicts.push({
          type: 'enum_drift',
          detail: `枚举值重叠度低 (${Math.round(intersection / union * 100)}%)`
        });
      }
    }
    return conflicts;
  }

  /* ============================================================
     Rewrite rule column references for target dataset
     ============================================================ */

  rewriteRuleColumns(rule, columnMapping) {
    const r = deepClone(rule);
    const map = (name) => columnMapping[name] || name;

    if (r.column) r.column = map(r.column);
    if (r.thisColumn) r.thisColumn = map(r.thisColumn);
    if (r.columns && Array.isArray(r.columns)) {
      r.columns = r.columns.map(map);
    }
    if (r.mapping && typeof r.mapping === 'object') {
      const newMapping = {};
      for (const [k, v] of Object.entries(r.mapping)) {
        newMapping[map(k)] = v;
      }
      r.mapping = newMapping;
    }
    return r;
  }

  /* ============================================================
     Persistence (delegates to store)
     ============================================================ */

  async saveRecipe(recipe) {
    try {
      await store.saveRecipe(recipe);
      return true;
    } catch (err) {
      if (store._memoryStore.has('recipe_' + recipe.id)) return true;
      throw err;
    }
  }

  async loadRecipes() {
    return await store.listRecipes();
  }

  async deleteRecipe(id) {
    await store.deleteRecipe(id);
  }

  /* ============================================================
     JSON Export / Import
     ============================================================ */

  exportRecipeJSON(recipe) {
    const data = {
      type: 'csv-cleaner-recipe',
      version: 1,
      exportedAt: new Date().toISOString(),
      recipe: deepClone(recipe)
    };
    const json = JSON.stringify(data, null, 2);
    downloadFile(json, (recipe.name || 'recipe') + '.json', 'application/json');
  }

  importRecipeJSON(jsonText) {
    const data = JSON.parse(jsonText);
    let recipe;
    if (data.type === 'csv-cleaner-recipe' && data.recipe) {
      recipe = data.recipe;
    } else if (data.steps && data.columnFingerprints) {
      recipe = data;
    } else {
      throw new Error('无效的配方 JSON 格式');
    }

    // Validate required fields
    if (!recipe.id) recipe.id = uid();
    if (!recipe.name) recipe.name = '导入的配方';
    if (!recipe.version) recipe.version = 1;
    if (!recipe.createdAt) recipe.createdAt = Date.now();
    if (!recipe.updatedAt) recipe.updatedAt = Date.now();
    if (!recipe.sourceInfo) recipe.sourceInfo = { fileName: '', rowCount: 0, columnCount: 0 };
    if (!Array.isArray(recipe.columnFingerprints)) recipe.columnFingerprints = [];
    if (!Array.isArray(recipe.steps)) throw new Error('配方缺少步骤数据');

    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i];
      if (!step.stepId) step.stepId = uid();
      if (step.order == null) step.order = i;
      if (!step.rule) throw new Error(`步骤 ${i + 1} 缺少规则数据`);
      if (!step.columnRefs) step.columnRefs = this._extractColumnRefs(step.rule);
      if (!step.description) step.description = this._stepDescription(step.rule);
    }

    return recipe;
  }

  /* ---- Recording prompt after rule execution ---- */

  async offerRecording(rules, dataset) {
    const name = prompt('将当前规则录制为配方，请输入名称:', (dataset.name || 'data') + '_配方');
    if (!name) return null;
    const recipe = this.createRecipeFromRules(name, rules, dataset);
    await this.saveRecipe(recipe);
    toast(`配方已保存: ${name}`, 'success');
    if (this.app.recipePanel) this.app.recipePanel.render();
    return recipe;
  }
}
