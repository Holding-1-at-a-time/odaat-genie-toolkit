// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingTalk
//
// Copyright 2017-2019 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//         Silei Xu <silei@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');

const ThingTalk = require('thingtalk');
const Ast = ThingTalk.Ast;
const Type = ThingTalk.Type;
const Grammar = ThingTalk.Grammar;
const SchemaRetriever = ThingTalk.SchemaRetriever;
const Units = ThingTalk.Units;

const { clean, pluralize, typeToStringSafe } = require('./utils');

function identity(x) {
    return x;
}

function makeExampleFromQuery(id, q) {
    const examples = [];
    const device = new Ast.Selector.Device(q.class.name, null, null);
    const invocation = new Ast.Invocation(device, q.name, [], q);
    const canonical = invocation.canonical ? invocation.canonical : clean(q.name);
    const canonicals = [canonical];
    const pluralized = pluralize(canonical);
    if (pluralized !== canonical)
        canonicals.push(pluralized);
    const table = new Ast.Table.Invocation(invocation, q);
    examples.push(new Ast.Example(
        -1,
        'query',
        {},
        table,
        canonicals,
        canonicals,
        {}
    ));
    if (id && id.has_ner_support === 1) {
        const filter = new Ast.BooleanExpression.Atom('id', '==', new Ast.Value.VarRef('p_id'));
        examples.push(new Ast.Example(
            -1,
            'query',
            { p_id: Type.Entity(id.type) },
            new Ast.Table.Filter(table, filter, q),
            [`\${p_id}`],
            [`\${p_id}`],
            {}
        ));
    }
    if (id && id.has_ner_support) {
        const idfilter = new Ast.BooleanExpression.Atom('id', '==', new Ast.Value.VarRef('p_id'));
        examples.push(new Ast.Example(
            -1,
            'query',
            { p_id: Type.Entity(id.type) },
            new Ast.Table.Filter(table, idfilter, q),
            [`\${p_id}`],
            [`\${p_id}`],
            {}
        ));
        const namefilter = new Ast.BooleanExpression.Atom('name', '=~', new Ast.Value.VarRef('p_name'));
        examples.push(new Ast.Example(
            -1,
            'query',
            { p_name: Type.String },
            new Ast.Table.Filter(table, namefilter, q),
            [`\${p_name}`],
            [`\${p_name}`],
            {}
        ));
    }
    return examples;
}

function makeExampleFromAction(a) {
    const examples = [];
    const device = new Ast.Selector.Device(a.class.name, null, null);
    const invocation = new Ast.Invocation(device, a.name, [], a);
    const canonical = invocation.canonical ? invocation.canonical : clean(a.name);
    const canonicals = [canonical];
    const pluralized = pluralize(canonical);
    if (pluralized !== canonical)
        canonicals.push(pluralized);
    examples.push(new Ast.Example(
        -1,
        'action',
        {},
        new Ast.Action.Invocation(invocation, a),
        canonicals,
        canonicals,
        {}
    ));
    return examples;
}

class ThingpediaLoader {
    async init(runtime, grammar, langPack, options) {
        this._runtime = runtime;
        this._grammar = grammar;
        this._langPack = langPack;

        this._tpClient = options.thingpediaClient;
        if (!options.schemaRetriever)
            options.schemaRetriever = new SchemaRetriever(this._tpClient, null, !options.debug);
        this._schemas = options.schemaRetriever;

        this._options = options;
        this.rng = options.rng;

        this._allTypes = new Map;
        this._idTypes = new Set;
        this._nonConstantTypes = new Set;
        this._entities = new Map;
        this.types = {
            all: this._allTypes,
            id: this._idTypes,
            nonConstant: this._nonConstantTypes,
            entities: this._entities
        };
        this.params = {
            in: new Map,
            out: new Set,
            blacklist: new Set,
        };
        this.compoundArrays = new Map;
        if (this._options.white_list)
            this.whiteList = this._options.white_list.toLowerCase().split(',');
        else
            this.whiteList = null;

        const [say, get_gps, get_time] = await Promise.all([
            this._tryGetStandard('org.thingpedia.builtin.thingengine.builtin', 'action', 'say'),
            this._tryGetStandard('org.thingpedia.builtin.thingengine.builtin', 'query', 'get_gps'),
            this._tryGetStandard('org.thingpedia.builtin.thingengine.builtin', 'query', 'get_time')
        ]);
        this.standardSchemas = { say, get_gps, get_time };

        // make sure that these types are always available, regardless of which templates we have
        this._recordType(Type.String);
        this._recordType(Type.Date);
        this._recordType(Type.Currency);
        this._recordType(Type.Number);
        for (let unit of Units.BaseUnits)
            this._recordType(Type.Measure(unit));

        await this._loadMetadata();
    }

    get flags() {
        return this._options.flags;
    }

    async _tryGetStandard(kind, functionType, fn) {
        try {
            return await this._schemas.getMeta(kind, functionType, fn);
        } catch(e) {
            return null;
        }
    }

    _recordType(type) {
        if (type.isCompound) {
            for (let field in type.fields)
                this._recordType(type.fields[field].type);
            return null;
        }
        if (type.isArray)
            this._recordType(type.elem);
        const typestr = typeToStringSafe(type);
        if (this._allTypes.has(typestr))
            return typestr;
        this._allTypes.set(typestr, type);

        this._grammar.declareSymbol('out_param_' + typestr);
        this._grammar.declareSymbol('placeholder_' + typestr);
        if (type.isArray) {
            this._grammar.addRule('out_param_Array__Any',  [new this._runtime.NonTerminal('out_param_' + typestr)],
                this._runtime.simpleCombine(identity));
        } else {
            this._grammar.addRule('out_param_Any',  [new this._runtime.NonTerminal('out_param_' + typestr)],
                this._runtime.simpleCombine(identity));
        }

        if (!this._grammar.hasSymbol('constant_' + typestr)) {
            if (!type.isEnum && !type.isEntity && !type.isArray)
                throw new Error('Missing definition for type ' + typestr);
            this._grammar.declareSymbol('constant_' + typestr);
            this._grammar.addRule('constant_Any', [new this._runtime.NonTerminal('constant_' + typestr)],
                this._runtime.simpleCombine(identity));

            if (type.isEnum) {
                for (let entry of type.entries) {
                    const value = new Ast.Value.Enum(entry);
                    value.getType = function() { return type; };
                    this._grammar.addRule('constant_' + typestr, [clean(entry)],
                        this._runtime.simpleCombine(() => value));
                }
            } else if (type.isEntity) {
                if (!this._nonConstantTypes.has(typestr) && !this._idTypes.has(typestr))
                    this._grammar.addConstants('constant_' + typestr, 'GENERIC_ENTITY_' + type.type, type);
            }
        }
        return typestr;
    }

    _addOutParam(pname, typestr, cat, canonical) {
        this._grammar.declareSymbol('out_param_' + cat);
        if (cat === 'npp') {
            for (let candidate of canonical)
                this._grammar.addRule('out_param_' + typestr, [candidate], this._runtime.simpleCombine(() => new Ast.Value.VarRef(pname)));
        }
        if (cat === 'npv' || cat === 'apv') {
            this._grammar.addRule('out_param_' + cat, [''], this._runtime.simpleCombine(() => new Ast.Value.VarRef(pname)));
        } else {
            for (let candidate of canonical)
                this._grammar.addRule('out_param_' + cat, [candidate], this._runtime.simpleCombine(() => new Ast.Value.VarRef(pname)));
        }
    }

    _recordOutputParam(pname, ptype, arg) {
        const drop = arg.getAnnotation('drop');
        if (drop)
            return;

        const key = pname + '+' + ptype;
        if (this.params.out.has(key))
            return;
        this.params.out.add(key);

        const useGenie = arg.getAnnotation('genie');
        if (useGenie !== undefined && !useGenie)
            this.params.blacklist.add(key);

        const typestr = this._recordType(ptype);

        if (ptype.isCompound)
            return;

        if (ptype.isBoolean)
            return;

        if (ptype.isArray && ptype.elem.isCompound) {
            this.compoundArrays[pname] = ptype.elem;
            for (let field in ptype.elem.fields) {
                let arg = ptype.elem.fields[field];
                this._recordOutputParam(field, arg.type, arg);
            }
        }

        let expansion;
        const argNameOverrides = this._langPack.ARGUMENT_NAME_OVERRIDES;
        if (pname in argNameOverrides)
            expansion = argNameOverrides[pname];
        else if (typeof arg.metadata.canonical !== 'object')
            expansion = [arg.canonical];

        if (expansion) {
            this._addOutParam(pname, typestr, 'npp', expansion);
        } else {
            Object.entries(arg.metadata.canonical).forEach(([cat, canonical]) => {
                if (cat !== 'default')
                    this._addOutParam(pname, typestr, cat, canonical);
            });
        }

    }

    _isHumanEntity(type) {
        if (['tt:contact', 'tt:username', 'org.wikidata:human'].includes(type))
            return true;
        if (type.startsWith('org.schema') && type.endsWith(':Person'))
            return true;
        return false;
    }

    async _loadTemplate(ex) {
        // return grammar rules added
        const rules = [];

        try {
            await ex.typecheck(this._schemas, true);
        } catch(e) {
            if (!e.message.startsWith('Invalid kind '))
                console.error(`Failed to load example ${ex.id}: ${e.message}`);
            return [];
        }

        // ignore builtin actions:
        // debug_log is not interesting, say is special and we handle differently, configure/discover are not
        // composable
        if (ex.type === 'action' && ex.value.invocation.selector.kind === 'org.thingpedia.builtin.thingengine.builtin') {
            if (this._options.flags.turking)
                return [];
            if (!this._options.flags.configure_actions && (ex.value.invocation.channel === 'configure' || ex.value.invocation.channel === 'discover'))
                return [];
            if (ex.value.invocation.channel === 'say')
                return [];
        }
        if (ex.type === 'stream' && (ex.value.isTimer || ex.value.isAtTimer))
            return [];
        if (this._options.flags.nofilter && (ex.value.isFilter || ex.value.isEdgeFilter || (ex.value.isMonitor && ex.value.table.isFilter)))
            return [];

        // ignore optional input parameters
        // if you care about optional, write a lambda template
        // that fills in the optionals

        if (ex.type === 'program') {
            // make up a fake expression signature that we attach to this program
            // FIXME we really should not need this mess...

            const args = [];
            for (let pname in ex.args) {
                let ptype = ex.args[pname];
                // FIXME use the annotation (or find the info in thingpedia)
                const pcanonical = clean(pname);
                args.push(new Ast.ArgumentDef(Ast.ArgDirection.IN_REQ, pname, ptype, { canonical: pcanonical }, {}));

                this.params.in.set(pname + '+' + ptype, [pname, [typeToStringSafe(ptype), pcanonical]]);
                this._recordType(ptype);
            }

            ex.value.schema = new Ast.ExpressionSignature('action', [], args, false, false);
        } else {
            for (let pname in ex.args) {
                let ptype = ex.args[pname];

                //console.log('pname', pname);
                if (!(pname in ex.value.schema.inReq)) {
                    // somewhat of a hack, we declare the argument for the value,
                    // because later we will muck with schema only
                    ex.value.schema = ex.value.schema.addArguments([new Ast.ArgumentDef(
                        Ast.ArgDirection.IN_REQ,
                        pname,
                        ptype,
                        {canonical: clean(pname)},
                        {}
                    )]);
                }
                const pcanonical = ex.value.schema.getArgCanonical(pname);

                this.params.in.set(pname + '+' + ptype, [pname, [typeToStringSafe(ptype), pcanonical]]);
                this._recordType(ptype);
            }
            for (let pname in ex.value.schema.out) {
                let ptype = ex.value.schema.out[pname];
                this._recordOutputParam(pname, ptype, ex.value.schema.getArgument(pname));
            }
        }

        if (ex.type === 'query') {
            if (Object.keys(ex.args).length === 0 && ex.value.schema.hasArgument('id')) {
                let type = ex.value.schema.getArgument('id').type;
                if (type.isEntity && this._isHumanEntity(type.type)) {
                    let grammarCat = 'thingpedia_who_question';
                    this._grammar.addRule(grammarCat, [''], this._runtime.simpleCombine(() => ex.value));
                }
            }
        }

        for (let preprocessed of ex.preprocessed) {
            let grammarCat = 'thingpedia_' + ex.type;

            if (grammarCat === 'thingpedia_query' && preprocessed[0] === ',') {
                preprocessed = preprocessed.substring(1).trim();
                grammarCat = 'thingpedia_get_command';
            }

            if (this._options.debug && preprocessed[0].startsWith(','))
                console.log(`WARNING: template ${ex.id} starts with , but is not a query`);

            let chunks = preprocessed.trim().split(' ');
            let expansion = [];

            for (let chunk of chunks) {
                if (chunk === '')
                    continue;
                if (chunk.startsWith('$') && chunk !== '$$') {
                    const [, param1, param2, opt] = /^\$(?:\$|([a-zA-Z0-9_]+(?![a-zA-Z0-9_]))|{([a-zA-Z0-9_]+)(?::([a-zA-Z0-9_-]+))?})$/.exec(chunk);
                    let param = param1 || param2;
                    assert(param);
                    expansion.push(new this._runtime.Placeholder(param, opt));
                } else {
                    expansion.push(chunk);
                }
            }

            this._grammar.addRule(grammarCat, expansion, this._runtime.simpleCombine(() => ex.value));
            rules.push({ category: grammarCat, expansion: chunks, example: ex });
        }
        return rules;
    }

    async _loadDevice(device) {
        this._grammar.addRule('constant_Entity__tt__device', [device.kind_canonical],
            this._runtime.simpleCombine(() => new Ast.Value.Entity(device.kind, 'tt:device', null)));
        if (this._options.flags.schema_org) {
            const code = await this._tpClient.getDeviceCode(device.kind);
            const parsed = await Grammar.parse(code);
            const classDef = parsed.classes[0];
            await Promise.all([
                Promise.all(Object.values(classDef.queries).map(async (q) => {
                    if (this.whiteList && this.whiteList.includes(q.name.toLowerCase())) {
                        const id = this._entities[`${classDef.name}:${q.name}`];
                        const examples = makeExampleFromQuery(id, q);
                        for (let ex of examples)
                            await this._loadTemplate(ex);
                    }
                })),
                Promise.all(Object.values(classDef.actions).map(async (a) => {
                    if (this.whiteList && this.whiteList.includes(a.name.toLowerCase())) {
                        const examples = makeExampleFromAction(a);
                        for (let ex of examples)
                            await this._loadTemplate(ex);
                    }
                })),
            ]);
        }
    }

    _loadIdType(idType) {
        let type = typeToStringSafe(Type.Entity(idType.type));
        if (this._idTypes.has(type))
            return;

        if (idType.type.endsWith(':id')) {
            if (this._options.debug)
                console.log('Loaded type ' + type + ' as id type');
            this._idTypes.add(type);
        } else {
            if (idType.has_ner_support) {
                if (this._options.debug)
                    console.log('Loaded type ' + type + ' as generic entity');
            } else {
                if (this._options.debug)
                    console.log('Loaded type ' + type + ' as non-constant type');
                this._nonConstantTypes.add(type);
            }
        }
    }

    async _loadCanonical(kind) {
        if (kind.startsWith('org.thingpedia.dynamic.by_kinds.'))
            kind = kind.substring('org.thingpedia.dynamic.by_kinds.'.length);
        try {
            const classDef = await this._schemas.getFullMeta(kind);
            const canonicals = {};
            Object.keys(classDef.queries).forEach((q) => {
                canonicals[q] = classDef.queries[q].metadata.canonical;
            });
            Object.keys(classDef.actions).forEach((a) => {
                canonicals[a] = classDef.actions[a].metadata.canonical;
            });
            return canonicals;
        } catch (e) {
            return undefined;
        }
    }

    makeExample(type, args, value, preprocessed) {
        return new Ast.Example(
            -1,
            type,
            args,
            value,
            [preprocessed],
            [preprocessed],
            {}
        );
    }

    async _getDataset(kind) {
        return await this._tpClient.getExamplesByKinds([kind]);
    }

    // takes an expansion (array), a canonical (a string), and another expansion to replace the canonical
    // the canonical is guaranteed to appear exactly once in the original expansion
    _expandExpansion(expansion, canonical, replacement) {
        const string = expansion.join(' ');
        const indexStart = string.indexOf(canonical);
        const indexEnd = indexStart + canonical.length;
        return string.substr(0, indexStart).trim().split(' ').concat(
            replacement
        ).concat(
            string.substr(indexEnd + 1).trim().split(' ')
        ).filter((token) => token !== '').join(' ');
    }


    // return true if two examples conflict with each other
    _conflictExample(expanderExample, ruleExample) {
        let invocation;
        for (let [, inv] of expanderExample.iteratePrimitives())
            invocation = inv;
        const channel = invocation.channel;
        const usedInput = invocation.in_params.map((p) => p.name);

        for (let [, inv] of ruleExample.iteratePrimitives()) {
            if (inv.channel === channel) {
                for (let in_param of inv.in_params) {
                    if (!in_param.value.isUndefined && usedInput.includes(in_param.name))
                        return true;
                }
            }
        }

        return false;
    }


    async _expandDataset(canonical, expander, rules) {
        const filter = expander.example.value.filter;
        await Promise.all(rules.map((rule) =>  {
            if (rule.category !== 'thingpedia_query')
                return;
            if (expander.example.id !== -1 && expander.example.id === rule.example.id)
                return;


            // skip rules with filter on the same parameter
            // TODO: replace this with more robust check and move to _conflictExample
            if (rule.example.value.isFilter) {
                if (filter.isAtom && rule.example.value.filter.isAtom) {
                    if (filter.name === rule.example.value.filter.name)
                        return;
                }
            }

            // skip rules if the same input parameter is used
            if (this._conflictExample(expander.example, rule.example))
                return;

            const args = Object.assign({}, expander.example.args);
            for (let arg of Object.keys(rule.example.args)) {
                // skip rules use the same arguments
                // (in most cases, this will skip rules with same input or have filters on the same param
                //  but if the value of the input/filter is a constant, then this won't work)
                if (arg in args)
                    return;
                args[arg] = rule.example.args[arg];
            }

            const value = new Ast.Table.Filter(rule.example.value, filter, null);
            const preprocessed = this._expandExpansion(expander.expansion, canonical, rule.expansion);

            const ex = this.makeExample('query', args, value, preprocessed);
            this._safeLoadTemplate(ex);
        }));
    }

    // load dataset for one device
    async _loadDataset(dataset) {
        const kind = dataset.name.substr(1);
        let rules = {};
        for (let ex of dataset.examples) {
            const newrules = await this._safeLoadTemplate(ex);

            let invocation;
            for (let [, inv] of ex.iteratePrimitives())
                invocation = inv;

            if (invocation.channel in rules)
                rules[invocation.channel] = rules[invocation.channel].concat(newrules);
            else
                rules[invocation.channel] = newrules;
        }

        if (!this._options.flags.expand_primitives)
            return;
        const canonicals = await this._loadCanonical(kind);
        if (!canonicals)
            return;
        for (let channel in rules) {
            const canonical = canonicals[channel].toLowerCase().trim();
            for (let rule of rules[channel]) {
                if (rule.category !== 'thingpedia_query')
                    continue;
                const re = new RegExp(canonical, "g");
                const matches = rule.expansion.join(' ').match(re);
                if (!matches || matches.length !== 1)
                    continue;
                if (!rule.example.value.isFilter || !rule.example.value.table.isInvocation)
                    continue;
                await this._expandDataset(canonical, rule, rules[channel]);
            }
        }
    }

    async _safeLoadTemplate(ex) {
        try {
            return await this._loadTemplate(ex);
        } catch(e) {
            throw new TypeError(`Failed to load example ${ex.id}: ${e.message}`);
        }
    }

    async _loadMetadata() {
        const [devices, idTypes] = await Promise.all([
            this._tpClient.getAllDeviceNames(),
            this._tpClient.getAllEntityTypes()
        ]);

        let datasets = await Promise.all(devices.map(async (d) => {
            return Grammar.parse(await this._getDataset(d.kind)).datasets[0];
        }));
        datasets = datasets.filter((d) => !!d);
        if (datasets.length === 0) {
            const code = await this._tpClient.getAllExamples();
            datasets = await Grammar.parse(code).datasets;
        }

        if (this._options.debug) {
            const countTemplates = datasets.map((d) => d.examples.length).reduce((a, b) => a+b, 0);
            console.log('Loaded ' + devices.length + ' devices');
            console.log('Loaded ' + countTemplates + ' templates');
        }

        idTypes.forEach((entity) => this._entities[entity.type] = entity);
        idTypes.forEach(this._loadIdType, this);
        await Promise.all([
            Promise.all(devices.map(this._loadDevice, this)),
            Promise.all(datasets.map(this._loadDataset, this))
        ]);
    }
}

module.exports = new ThingpediaLoader();
