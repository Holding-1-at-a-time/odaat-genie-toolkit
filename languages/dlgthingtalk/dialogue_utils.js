// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of Genie
//
// Copyright 2020 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const assert = require('assert');

const ThingTalk = require('thingtalk');
const Ast = ThingTalk.Ast;

const C = require('./ast_manip');
const _loader = require('./load-thingpedia');
const { SlotBag, checkAndAddSlot } = require('./slot_bag');
const { arraySubset } = require('./array_utils');

const {
    POLICY_NAME,
    INITIAL_CONTEXT_INFO,

    getContextInfo,
    isUserAskingResultQuestion,
    getActionInvocation,
    checkStateIsValid,

    makeSimpleState,
    addActionParam,
    addAction,
    addQuery,
} = require('./state_manip');

function isFilterCompatibleWithResult(topResult, filter) {
    if (filter.isTrue || filter.isDontCare)
        return true;
    if (filter.isFalse)
        return false;
    if (filter.isAnd)
        return filter.operands.every((op) => isFilterCompatibleWithResult(topResult, op));
    if (filter.isOr)
        return filter.operands.some((op) => isFilterCompatibleWithResult(topResult, op));
    if (filter.isNot)
        return !isFilterCompatibleWithResult(topResult, filter.expr);

    if (filter.isExternal) // approximate
        return true;

    if (filter.isCompute) // approximate
        return true;

    const values = topResult.value;

    // if the value was not returned, don't verbalize it
    if (!values[filter.name])
        return false;

    const resultValue = topResult.value[filter.name];

    switch (filter.operator) {
    case '==':
    case '=~':
        // approximate: all strings are made up so we don't need a true likeTest here
        return resultValue.toJS() === filter.value.toJS();

    default:
        // approximate
        return true;
    }
}

function isInfoPhraseCompatibleWithResult(topResult, info) {
    for (let [pname, infoValue] of info) {
        const resultValue = topResult.value[pname];
        if (!resultValue)
            return false;

        if (resultValue.isArray && infoValue.isArray) {
            if (!arraySubset(infoValue.value, resultValue.value))
                return false;
        } else {
            if (!resultValue.equals(infoValue))
                return false;
        }
    }
    return true;
}

function makeActionRecommendation(ctx, action) {
    assert(action instanceof Ast.Invocation);

    const results = ctx.results;
    assert(results.length > 0);

    const topResult = results[0];
    const id = topResult.value.id;
    if (!id)
        return null;

    for (let param of action.in_params) {
        if (param.value.equals(id))
            return { topResult, info: null, action };
    }

    return null;
}

function makeRecommendation(ctx, name) {
    const results = ctx.results;
    assert(results.length > 0);

    const topResult = results[0];
    const id = topResult.value.id;

    if (!id || !id.equals(name))
        return null;

    return { topResult, ctx, info: null, action: ctx.nextInfo && ctx.nextInfo.isAction ? getActionInvocation(ctx.next) : null };
}

function checkInfoPhrase(ctx, info) {
    if (ctx.currentFunction !== info.schema.class.name + ':' + info.schema.name)
        return null;

    // check that the filter uses the right set of parameters
    if (ctx.resultInfo.projection !== null) {
        // check that all projected names are present
        for (let name of ctx.resultInfo.projection) {
            if (!info.has(name))
                return null;
        }
    } else {
        // we must have at least one result to be here
        let topResult = ctx.results[0];
        assert(topResult);

        // check that the names are part of the #[default_projection], if one is specified
        for (let name of info.keys()) {
            if (!topResult.value[name])
                return null;
        }
    }

    // check that the filter is compatible with at least one of the top 3 results
    let good = false;
    const results = ctx.results;
    for (let i = 0; i < Math.min(3, results.length); i++) {
        if (isInfoPhraseCompatibleWithResult(results[i], info)) {
            good = true;
            break;
        }
    }

    if (good)
        return info;
    else
        return null;
}

function checkRecommendation({ topResult, action: nextAction }, info) {
    assert(info instanceof SlotBag);
    const resultType = topResult.value.id.getType();
    const idType = info.schema.getArgType('id');

    if (!idType || !idType.equals(resultType))
        return null;

    if (!isInfoPhraseCompatibleWithResult(topResult, info))
        return null;

    return { topResult, info, action: nextAction };
}

function makeShortUserQuestionAnswer({ topResult, ctx, action }, filter) {
    let info = new SlotBag(ctx.currentFunctionSchema);
    info = checkAndAddSlot(info, filter);
    if (info === null)
        return null;
    info = checkInfoPhrase(ctx, info);
    if (info === null)
        return null;

    return checkRecommendation({ topResult, action }, info);
}

function checkListProposal(ctx, results, info) {
    const resultType = results[0].value.id.getType();
    const idType = info.schema.getArgType('id');

    if (!idType || !idType.equals(resultType))
        return null;

    for (let result of results) {
        if (!isInfoPhraseCompatibleWithResult(result, info))
            return null;
    }

    const action = ctx.nextInfo && ctx.nextInfo.isAction ? getActionInvocation(ctx.next) : null;
    return [results, info, action];
}

function isFilterCompatibleWithInfo(info, filter) {
    assert(filter instanceof Ast.BooleanExpression);
    if (filter.isTrue || filter.isDontCare)
        return true;
    if (filter.isFalse)
        return false;
    if (filter.isOr)
        return filter.operands.some((op) => isFilterCompatibleWithInfo(info, op));
    if (filter.isAnd)
        return filter.operands.every((op) => isFilterCompatibleWithInfo(info, op));
    if (filter.isNot)
        return !isFilterCompatibleWithInfo(info, filter.expr);

    // approximate
    if (filter.isExternal || filter.isCompute)
        return true;

    assert(filter.isAtom);
    const pname = filter.name;
    if (!info.has(pname))
        return false;

    switch (filter.operator) {
    case '==':
    case '=~':
        return filter.value.equals(info.get(pname));

    case 'contains':
    case 'contains~':
        return info.get(pname).value.some((v) => v.equals(filter.value));

    case 'in_array':
    case 'in_array~':
        return filter.value.value.some((v) => v.equals(info.get(pname)));

    case '>=':
        return info.get(pname).toJS() >= filter.value.toJS();
    case '<=':
        return info.get(pname).toJS() <= filter.value.toJS();

    default:
        // approximate
        return true;
    }
}

function isValidNegativePreambleForInfo(info, preamble) {
    // the preamble must match the info provided
    // (and we will negate it later)
    return isFilterCompatibleWithInfo(info, preamble.filter);
}

function checkActionForRecommendation({ topResult, info, action: nextAction }, action) {
    const resultType = topResult.value.id.getType();

    if (nextAction !== null) {
        if (!C.isSameFunction(nextAction.schema, action.schema))
            return null;
    }

    if (!C.hasArgumentOfType(action, resultType))
        return null;

    return { topResult, info, action };
}

function makeRefinementProposal(ctx, proposal) {
    assert(proposal.isFilter && proposal.table.isInvocation);

    let ctxTable, ctxFilterTable;
    ctxTable = ctx.current.stmt.table.clone();
    [ctxTable, ctxFilterTable] = findOrMakeFilterTable(ctxTable);
    if (ctxFilterTable === null)
        return null;

    const refinedFilter = refineFilterToAnswerQuestion(ctxFilterTable.filter, proposal.filter);
    if (refinedFilter === null)
        return null;
    return proposal;
}

function mergePreambleAndRequest(pair, request) {
    const preamble = pair[pair.length-1];
    if (!C.isSameFunction(preamble.schema, request.schema))
        return null;
    const refined = refineFilterToChangeFilter(preamble.filter, request.filter);
    if (refined === null)
        return null;

    // convert the preamble into a request by negating it, then add the new request
    return [...pair.slice(0, pair.length-1), new Ast.Table.Filter(null, request.table, new Ast.BooleanExpression.And(null, [
        new Ast.BooleanExpression.Not(null, preamble.filter),
        request.filter
    ]), request.schema)];
}

function initialRequest(stmt) {
    if (stmt.stream && _loader.flags.no_stream)
        return null;

    let history = [];

    if (stmt.table && stmt.actions.some((a) => !a.isNotify)) {
        // split into two statements, one getting the data, and the other using it

        if (!stmt.table.isInvocation) {
            // if there is no filter, skip the statement
            const queryStmt = new Ast.Statement.Command(null, stmt.table, [C.notifyAction()]);
            history.push(new Ast.DialogueHistoryItem(null, queryStmt, null, false));
        }
        if (!C.checkValidQuery(stmt.table))
            return null;

        const newActions = stmt.actions.map((a) => a.clone());
        for (let action of newActions) {
            if (!action.isInvocation)
                throw new TypeError('???');
            assert (action.invocation.selector.isDevice);

            const in_params = action.invocation.in_params;
            for (let in_param of in_params) {
                if (!in_param.value.isVarRef)
                    continue;
                if (in_param.value.name.startsWith('__const_'))
                    continue;

                // parameter passing
                // FIXME we need a new ThingTalk value type...
                in_param.value = new Ast.Value.Undefined(true);
            }
        }
        const actionStmt = new Ast.Statement.Command(null, null, newActions);
        history.push(new Ast.DialogueHistoryItem(null, actionStmt, null, false));
    } else {
        if (stmt.table && !C.checkValidQuery(stmt.table))
            return null;

        let newStatements = [];
        if (!stmt.table) {
            for (let action of stmt.actions) {
                for (let param of action.invocation.in_params) {
                    if (param.value.isUndefined) {
                        const type = action.invocation.schema.getArgType(param.name);
                        if (type.isEntity && _loader.idQueries.has(type.type)) {
                            const query = _loader.idQueries.get(type.type);
                            newStatements.push(new Ast.Statement.Command(null, new Ast.Table.Invocation(null,
                                new Ast.Invocation(null,
                                    new Ast.Selector.Device(null, query.class.name, null, null),
                                    query.name,
                                    [],
                                    query),
                                query), [C.notifyAction()]));
                        }
                    }
                }
            }
        }
        newStatements.push(stmt);

        for (let stmt of newStatements)
            history.push(new Ast.DialogueHistoryItem(null, stmt, null, false));
    }

    return new Ast.DialogueState(null, 'org.thingpedia.dialogue.transaction', 'execute', null, history);
}

/**
 * Check if the table filters on the parameters `questions` (effectively providing a constraint on question)
 */
function isQueryAnswerValidForQuestion(table, questions) {
    assert(Array.isArray(questions));
    if (questions.length === 0)
        return true;
    let answersQuestion = false;
    table.visit(new class extends Ast.NodeVisitor {
        visitAtomBooleanExpression(atom) {
            if (questions.some((q) => q === atom.name))
                answersQuestion = true;
            return true;
        }
        visitDontCareBooleanExpression(atom) {
            if (questions.some((q) => q === atom.name))
                answersQuestion = true;
            return true;
        }
    });
    return answersQuestion;
}

/**
 * Find the filter table in the context.
 *
 * If we don't have one, make it up right before the invocation.
 *
 * Returns [root, filterTable]
 */
function findOrMakeFilterTable(root) {
    let table = root;
    let holder = null;
    while (!table.isFilter) {
        if (table.isSequence ||
            table.isHistory ||
            table.isWindow ||
            table.isTimeSeries)
            throw new Error('NOT IMPLEMENTED');

        // do not touch these with filters
        if (table.isAggregation ||
            table.isVarRef ||
            table.isResultRef)
            return [null, null];

        // go inside these
        if (table.isSort ||
            table.isIndex ||
            table.isSlice ||
            table.isProjection ||
            table.isCompute ||
            table.isAlias) {
            holder = table;
            table = table.table;
            continue;
        }

        if (table.isJoin) {
            holder = table;
            // go right on join, always
            table = table.rhs;
            continue;
        }

        assert(table.isInvocation);
        // if we get here, there is no filter table at all
        // make up one
        const newFilterTable = new Ast.Table.Filter(null, table, Ast.BooleanExpression.True, table.schema);
        if (holder === null) {
            assert(table === root);
            return [newFilterTable, newFilterTable];
        } else if (holder.isJoin) {
            holder.rhs = newFilterTable;
            return [root, newFilterTable];
        } else {
            holder.table = newFilterTable;
            return [root, newFilterTable];
        }
    }

    return [root, table];
}

function setsIntersect(s1, s2) {
    for (let el of s1) {
        if (s2.has(el))
            return true;
    }
    return false;
}

function getParamsInFilter(filter) {
    let params = new Set;
    filter.visit(new class extends Ast.NodeVisitor {
        visitAtomBooleanExpression(atom) {
            params.add(atom.name);
            return false;
        }
        visitDontCareBooleanExpression(atom) {
            params.add(atom.name);
            return false;
        }
        visitExternalBooleanExpression() {
            return false;
        }
    });
    return params;
}

function neutralizeIDFilter(ast) {
    // clone a filter and replace "id == ..." atoms with "true"

    if (ast.isNot)
        return new Ast.BooleanExpression.Not(null, neutralizeIDFilter(ast.expr));
    if (ast.isOr)
        return new Ast.BooleanExpression.Or(null, ast.operands.map(neutralizeIDFilter));
    if (ast.isAnd)
        return new Ast.BooleanExpression.And(null, ast.operands.map(neutralizeIDFilter));
    if (ast.isTrue || ast.isDontCare || ast.isFalse || ast.isCompute || ast.isExternal)
        return ast;

    assert(ast.isAtom);
    if (ast.name === 'id' && ast.operator === '==')
        return Ast.BooleanExpression.True;
    return ast;
}

function refineFilterToAnswerQuestion(ctxFilter, refinedFilter) {
    // this function is used when:
    // - the agent asks a search refinement question, and the user answers it
    // - the agent proposes something to refine the question
    //
    // the refinement is allowed only if the parameter was not mentioned before
    // furthermore, "id ==" filters are removed from the refined filter, so a user
    // can choose a restaurant for a while then change their mind

    if (setsIntersect(getParamsInFilter(ctxFilter),  getParamsInFilter(refinedFilter)))
        return null;

    const clone = neutralizeIDFilter(ctxFilter);
    return new Ast.BooleanExpression.And(null, [clone, refinedFilter]).optimize();
}

function filterToNegatedSlots(filter) {
    filter = filter.optimize();
    let operands, slots = {};
    if (filter.isAnd)
        operands = filter.operands;
    else
        operands = [filter];

    for (let operand of operands) {
        if (!operand.isNot)
            continue;
        let atom = operand.expr;
        if (!atom.isAtom && !atom.isDontCare)
            continue;

        slots[atom.name] = operand;
    }

    return slots;
}

function filterToSlots(filter) {
    filter = filter.optimize();
    let operands, slots = {};
    if (filter.isAnd)
        operands = filter.operands;
    else
        operands = [filter];

    for (let operand of operands) {
        if (!operand.isAtom && !operand.isDontCare)
            continue;

        slots[operand.name] = operand;
    }

    return slots;
}

function refineFilterToAnswerQuestionOrChangeFilter(ctxFilter, refinedFilter) {
    // this function is used:
    // - the agent proposes something, and the user replies with a bunch of filters
    //   (e.g. "how about terun?" "nah i'm looking for something chinese")
    //
    // the refinement is allowed only if the parameter was not mentioned before
    // at most one parameter can be mentioned in the context, in which case it must be different
    //
    // the refinement contains all clauses which are not explicitly negated in the refinement,
    // plus all of the refinement
    // furthermore, "id ==" filters are removed from the refined filter, so a user
    // can choose a restaurant for a while then change their mind

    ctxFilter = ctxFilter.optimize();
    refinedFilter = refinedFilter.optimize();

    const ctxSlots = filterToSlots(ctxFilter);
    const refinedSlots = filterToSlots(refinedFilter);
    const negatedRefinedSlots = filterToNegatedSlots(refinedFilter);

    let changedParam = undefined;
    // slots in the context must not mentioned in the refinement, except at most one can, and
    // it must be different operator or value
    //
    // note that both positive and negative filters are killed by this check
    // so neither "I want X food" nor "I don't like X food" are acceptable when "food =~ X" was
    // already in the context
    for (let key in ctxSlots) {
        assert(ctxSlots[key].isAtom || ctxSlots[key].isDontCare);
        if (negatedRefinedSlots[key])
            return null;
        if (refinedSlots[key]) {
            // dont change opinion from a dontcare to a not dontcare
            if (ctxSlots[key].isDontCare)
                return null;

            if (refinedSlots[key].equals(ctxSlots[key]))
                return null;
            if (changedParam !== undefined)
                return null;
            changedParam = key;
        }
    }

    const newCtxClauses = [];
    for (let clause of (ctxFilter.isAnd ? ctxFilter.operands : [ctxFilter])) {
        if (clause.isAtom || clause.isDontCare) {
            if (refinedSlots[clause.name])
                continue;
        }
        newCtxClauses.push(neutralizeIDFilter(clause));
    }

    return new Ast.BooleanExpression.And(null, [...newCtxClauses, refinedFilter]).optimize();
}


function refineFilterToChangeFilter(ctxFilter, refinedFilter) {
    // this function is used:
    // - when the agent returned zero results, and the user
    //   must change the search
    // - when the agent makes a filter proposal, and the user says no I want something else
    //
    // the refinement is allowed only if no new parameters are introduced (all parameters were
    // mentioned before), and at least one parameter is different than before
    //
    // the resulting filter uses all the parameters in ctxFilter that are not mentioned
    // in refinedFilter, as well as all of refinedFilter

    ctxFilter = ctxFilter.optimize();
    refinedFilter = refinedFilter.optimize();

    const ctxSlots = filterToSlots(ctxFilter);
    const refinedSlots = filterToSlots(refinedFilter);
    // all slots in the context must be either not mentioned in the refinement, or changed
    for (let key in ctxSlots) {
        if (refinedSlots[key] && refinedSlots[key].equals(ctxSlots[key]))
            return null;
    }
    // all slots that are in the refinement must be mentioned in the context
    for (let key in refinedSlots) {
        if (!ctxSlots[key])
            return null;
    }

    const ctxClauses = (ctxFilter.isAnd ? ctxFilter.operands : [ctxFilter]).filter((clause) => {
        let good = true;
        clause.visit(new class extends Ast.NodeVisitor {
             visitExternalBooleanExpression() {
                // do not recurse
                // get rid of get-predicates in the context, regardless
                good = false;
                return false;
            }
            visitValue() {
                // do not recurse
                return false;
            }

            visitAtomBooleanExpression(atom) {
                good = good && !C.filterUsesParam(refinedFilter, atom.name);
                return true;
            }
            visitDontCareBooleanExpression(atom) {
                good = good && !C.filterUsesParam(refinedFilter, atom.name);
                return true;
            }
        });
        return good;
    });

    return new Ast.BooleanExpression.And(null, [...ctxClauses, refinedFilter]).optimize();
}

function queryRefinement(ctxTable, newFilter, refineFilter, newProjection) {
    let cloneTable = ctxTable.clone();

    let filterTable;
    [cloneTable, filterTable] = findOrMakeFilterTable(cloneTable);
    //if (ctxFilterTable === null)
    //    return null;
    assert(filterTable.isFilter && filterTable.table.isInvocation);

    const refinedFilter = refineFilter(filterTable.filter, newFilter);
    if (refinedFilter === null)
        return null;

    filterTable.filter = refinedFilter;

    if (newProjection) {
        // if we have a new projection, we remove the projection entirely and replace it
        // with the new one

        if (cloneTable.isProjection)
            cloneTable = cloneTable.table;
        // there should be no projection of projection (will be optimized)
        assert(!cloneTable.isProjection);
        cloneTable = new Ast.Table.Projection(null, cloneTable, newProjection,
            C.resolveProjection(newProjection, cloneTable.schema));
    } else {
        // otherwise, we remove all fields from the projection that were mentioned in the
        // filter

        let oldProjection;
        if (cloneTable.isProjection) {
            oldProjection = cloneTable.args;
            cloneTable = cloneTable.table;
        }
        // there should be no projection of projection (will be optimized)
        assert(!cloneTable.isProjection);

        if (oldProjection) {
            newProjection = oldProjection.filter((pname) => !C.filterUsesParam(refinedFilter, pname));

            // if the projection is now empty, we don't add
            // the projection will be empty if
            // 1. the user asks a question
            // 2. the agent answers that question
            // 3. the user now refines the search indicating they don't like that answer
            //
            // on the other hand, if
            // 1. the user asks a question (eg. asks for "address")
            // 2. the agent answers that question
            // 3. the user now refines the search changing a different parameter
            // we will keep the projection

            if (newProjection.length > 0) {
                cloneTable = new Ast.Table.Projection(null, cloneTable, newProjection,
                    C.resolveProjection(newProjection, cloneTable.schema));
            }
        }
    }

    return cloneTable;
}

function isValidSearchQuestion(table, questions) {
    for (let q of questions) {
        const arg = table.schema.getArgument(q);
        if (!arg || arg.is_input)
            return false;
        if (arg.getAnnotation('filterable') === false)
            return false;
    }
    return true;
}

function preciseSearchQuestionAnswer(ctx, [questions, answer]) {
    const answerFunctions = C.getFunctionNames(answer);
    assert(answerFunctions.length === 1);
    if (answerFunctions[0] !== ctx.currentFunction)
        return null;
    const currentTable = ctx.current.stmt.table;
    if (!isValidSearchQuestion(currentTable, questions))
        return null;
    assert(answer.isFilter && answer.table.isInvocation);

    const newTable = queryRefinement(currentTable, answer.filter, refineFilterToAnswerQuestion);
    if (newTable === null)
        return null;
    const clone = ctx.clone();
    const userState = addQuery(clone, 'execute', newTable, 'accepted');
    let sysState;
    if (questions.length === 0)
        sysState = makeSimpleState(ctx, 'sys_generic_search_question', null);
    else
        sysState = makeSimpleState(ctx, 'sys_search_question', questions);
    return checkStateIsValid(ctx, sysState, userState);
}

function checkSearchResultPreamble(ctx, base, num, more) {
    if (base !== ctx.currentFunction)
        return null;
    if (num !== null) {
        if (!num.equals(ctx.current.count))
            return null;
        if (more !== ctx.current.more)
            return null;
    }

    return ctx;
}

function checkFilterPairForDisjunctiveQuestion(ctx, f1, f2) {
    if (f1.name !== f2.name)
        return null;
    if (!f1.value.getType().equals(f2.value.getType()))
        return null;
    if (f1.value.equals(f2.value))
        return null;

    let good1 = false;
    let good2 = false;
    for (let result of ctx.results) {
        const value = result.value[f1.name];
        if (!value)
            return null;
        if (value.equals(f1.value))
            good1 = true;
        if (value.equals(f2.value))
            good2 = true;
        if (good1 && good2)
            break;
    }
    if (!good1 || !good2)
        return null;

    return [f1.name, f1.value.getType()];
}

function impreciseSearchQuestionAnswer(ctx, [questions, answer]) {
    assert(Array.isArray(questions));
    const currentTable = ctx.current.stmt.table;
    if (!isValidSearchQuestion(currentTable, questions))
        return null;
    assert(answer instanceof Ast.BooleanExpression);
    if (!C.checkFilter(ctx.current.stmt.table, answer))
        return null;

    const newTable = queryRefinement(currentTable, answer, refineFilterToAnswerQuestion);
    if (newTable === null)
        return null;
    const clone = ctx.clone();
    const userState = addQuery(clone, 'execute', newTable, 'accepted');
    const sysState = makeSimpleState(ctx, 'sys_search_question', questions);
    return checkStateIsValid(ctx, sysState, userState);
}

function proposalReplyPair(ctx, [proposal, request]) {
    const requestFunctions = C.getFunctionNames(request);
    assert(requestFunctions.length === 1);
    if (requestFunctions[0] !== ctx.currentFunction)
        return null;
    assert(request.isFilter && request.table.isInvocation);

    const clone = ctx.clone();
    const currentTable = clone.current.stmt.table;
    const newTable = queryRefinement(currentTable, request.filter, refineFilterToAnswerQuestion);
    if (newTable === null)
        return null;

    const userState = addQuery(clone, 'execute', newTable, 'accepted');
    const sysState = addQuery(ctx.clone(), 'sys_propose_refined_query', proposal, 'proposed');
    return checkStateIsValid(ctx, sysState, userState);
}

function findChainParam(topResult, action) {
    const resultType = topResult.value.id.getType();

    let chainParam = undefined;
    for (let arg of action.schema.iterateArguments()) {
        if (arg.type.equals(resultType)) {
            chainParam = arg.name;
            break;
        }
    }
    assert(chainParam);
    return chainParam;
}

function negativeRecommendationReplyPair(ctx, [topResult, action, request]) {
    const requestFunctions = C.getFunctionNames(request);
    assert(requestFunctions.length === 1);
    if (requestFunctions[0] !== ctx.currentFunction)
        return null;
    assert(request.isFilter && request.table.isInvocation);

    const clone = ctx.clone();
    const currentTable = clone.current.stmt.table;
    const newTable = queryRefinement(currentTable, request.filter, refineFilterToAnswerQuestionOrChangeFilter);
    if (newTable === null)
        return null;

    const userState = addQuery(clone, 'execute', newTable, 'accepted');
    let sysState;
    if (action === null)
        sysState = makeSimpleState(ctx, 'sys_recommend_one', null);
    else
        sysState = addActionParam(ctx.clone(), 'sys_recommend_one', action, findChainParam(topResult, action), topResult.value.id, 'proposed');
    return checkStateIsValid(ctx, sysState, userState);
}

function positiveRecommendationReplyPair(ctx, [topResult, actionProposal, acceptedAction]) {
    // if acceptedAction === null, the user wants to know more about the result before
    // making a decision
    let userState;
    if (acceptedAction === null) {
        userState = makeSimpleState(ctx, 'learn_more', null);
    } else {
        const chainParam = findChainParam(topResult, acceptedAction);
        userState = addActionParam(ctx.clone(), 'execute', acceptedAction, chainParam, topResult.value.id, 'accepted');
    }

    let sysState;
    if (actionProposal === null) {
        sysState = makeSimpleState(ctx, 'sys_recommend_one', null);
    } else {
        const chainParam = findChainParam(topResult, actionProposal);
        sysState = addActionParam(ctx.clone(), 'sys_recommend_one', actionProposal, chainParam, topResult.value.id, 'proposed');
    }
    return checkStateIsValid(ctx, sysState, userState);
}

function areQuestionsValidForContext(ctx, questions) {
    for (const [qname, qtype] of questions) {
        if (!ctx.currentFunctionSchema.hasArgument(qname))
            return false;
        if (qtype !== null && !ctx.currentFunctionSchema.getArgType(qname).equals(qtype))
            return false;
    }
    return true;
}

function listProposalSearchQuestionPair(ctx, [results, name, actionProposal, questions]) {
    if (!areQuestionsValidForContext(ctx, questions))
        return false;

    const currentTable = ctx.current.stmt.table;
    const newFilter = new Ast.BooleanExpression.Atom(null, 'id', '==', name);
    const newTable = queryRefinement(currentTable, newFilter, refineFilterToAnswerQuestion,
        questions.map(([qname, qtype]) => qname));
    if (newTable === null)
        return null;

    const userState = addQuery(ctx.clone(), 'execute', newTable, 'accepted');

    let dialogueAct = results.length === 2 ? 'sys_recommend_two' : 'sys_recommend_three';
    let sysState;
    if (actionProposal === null)
        sysState = makeSimpleState(ctx, dialogueAct, null);
    else
        sysState = addAction(ctx.clone(), dialogueAct, actionProposal, 'proposed');

    return checkStateIsValid(ctx, sysState, userState);
}

function recommendationSearchQuestionPair(ctx, [topResult, actionProposal, questions]) {
    if (!areQuestionsValidForContext(ctx, questions))
        return false;

    let sysDialogueAct;
    if (topResult === null) {
        assert(actionProposal === null);
        sysDialogueAct = 'sys_learn_more_what';
        topResult = ctx.results[0];
    } else {
        sysDialogueAct = 'sys_recommend_one';
    }

    const currentTable = ctx.current.stmt.table;
    const newFilter = new Ast.BooleanExpression.Atom(null, 'id', '==', topResult.value.id);
    const newTable = queryRefinement(currentTable, newFilter, refineFilterToAnswerQuestion,
        questions.map(([qname, qtype]) => qname));
    if (newTable === null)
        return null;
    const userState = addQuery(ctx.clone(), 'execute', newTable, 'accepted');

    let sysState;
    if (actionProposal === null) {
        sysState = makeSimpleState(ctx, sysDialogueAct, null);
    } else {
        const chainParam = findChainParam(topResult, actionProposal);
        sysState = addActionParam(ctx.clone(), sysDialogueAct, actionProposal, chainParam, topResult.value.id, 'proposed');
    }

    return checkStateIsValid(ctx, sysState, userState);
}

function recommendationCancelPair(ctx, { topResult, action: actionProposal }) {
    // "thank you" closes the dialogue
    // we cannot close the dialogue if we have pending actions
    if (ctx.next)
        return null;

    const userState = makeSimpleState(ctx, 'cancel', null);

    let sysState;
    if (actionProposal === null) {
        sysState = makeSimpleState(ctx, 'sys_recommend_one', null);
    } else {
        const chainParam = findChainParam(topResult, actionProposal);
        sysState = addActionParam(ctx.clone(), 'sys_recommend_one', actionProposal, chainParam, topResult.value.id, 'proposed');
    }

    return checkStateIsValid(ctx, sysState, userState);
}

function negativeListProposalReplyPair(ctx, [results, action, request]) {
    const requestFunctions = C.getFunctionNames(request);
    assert(requestFunctions.length === 1);
    if (requestFunctions[0] !== ctx.currentFunction)
        return null;
    assert(request.isFilter && request.table.isInvocation);

    const currentTable = ctx.current.stmt.table;
    const newTable = queryRefinement(currentTable, request.filter, refineFilterToAnswerQuestionOrChangeFilter);
    if (newTable === null)
        return null;

    const clone = ctx.clone();
    const userState = addQuery(clone, 'execute', newTable, 'accepted');

    let dialogueAct = results.length === 2 ? 'sys_recommend_two' : 'sys_recommend_three';
    let sysState;
    if (action === null)
        sysState = makeSimpleState(ctx, dialogueAct, null);
    else
        sysState = addAction(ctx.clone(), dialogueAct, action, 'proposed');
    return checkStateIsValid(ctx, sysState, userState);
}

function positiveListProposalReplyPair(ctx, [results, actionProposal, name, acceptedAction]) {

    // if actionProposal === null the flow is roughly
    //
    // U: hello i am looking for a restaurant
    // A: how about the ... or the ... ?
    // U: I like the ... bla
    //
    // in this case, the agent should hit the "... is a ... restaurant in the ..."
    // we treat it as "execute" dialogue act and add a filter that causes the program to return a single result

    let userState;
    if (acceptedAction === null) {
        const currentTable = ctx.current.stmt.table;
        const namefilter = new Ast.BooleanExpression.Atom(null, 'id', '==', name);
        const newTable = queryRefinement(currentTable, namefilter, (one, two) => new Ast.BooleanExpression.And(null, [one, two]));
        if (newTable === null)
            return null;

         const clone = ctx.clone();
       userState = addQuery(clone, 'execute', newTable, 'accepted');
    } else {
        const chainParam = findChainParam(results[0], acceptedAction);
        userState = addActionParam(ctx.clone(), 'execute', acceptedAction, chainParam, name, 'accepted');
    }

    let dialogueAct = results.length === 2 ? 'sys_recommend_two' : 'sys_recommend_three';
    let sysState;
    if (actionProposal === null)
        sysState = makeSimpleState(ctx, dialogueAct, null);
    else
        sysState = addAction(ctx.clone(), dialogueAct, actionProposal, 'proposed');
    return checkStateIsValid(ctx, sysState, userState);
}

function impreciseSearchQuestionAnswerPair(questions, answer) {
    assert(Array.isArray(questions));
    if (answer instanceof Ast.BooleanExpression) {
        let pname;
        if (answer.isNot) {
            assert(answer.expr.isAtom || answer.expr.isDontCare);
            pname = answer.expr.name;
        } else {
            assert(answer.isAtom || answer.isDontCare);
            pname = answer.name;
        }
        if (!questions.some((q) => q === pname))
            return null;

        return [questions, answer];
    } else {
        assert(questions.length === 1);
        assert(answer instanceof Ast.Value);
        answer = C.makeFilter(new Ast.Value.VarRef(questions[0]), '==', answer);
        if (answer === null)
            return null;
        return [questions, answer];
    }
}

function emptySearchChangePair(ctx, [question, phrase]) {
    const currentTable = ctx.current.stmt.table;
    if (question !== null && !currentTable.schema.out[question])
        return null;

    const clone = ctx.clone();
    const [,ctxFilterTable] = findOrMakeFilterTable(clone.current.stmt.table);
    if (question !== null && !C.filterUsesParam(ctxFilterTable.filter, question))
        return null;

    const newTable = queryRefinement(currentTable, phrase.filter, refineFilterToChangeFilter);
    if (newTable === null)
        return null;
    const userState = addQuery(clone, 'execute', newTable, 'accepted');
    const sysState = makeSimpleState(ctx, question ? 'sys_empty_search_question' : 'sys_empty_search', question);
    return checkStateIsValid(ctx, sysState, userState);
}

function addDontCare(stmt, dontcare) {
    if (!stmt.table)
        return null;

    const arg = stmt.table.schema.getArgument(dontcare.name);
    if (!arg || arg.is_input)
        return null;
    if (arg.getAnnotation('filterable') === false)
        return null;

    let clone = stmt.clone();
    let [cloneTable, filterTable] = findOrMakeFilterTable(clone.table);
    clone.table = cloneTable;

    if (C.filterUsesParam(filterTable.filter, dontcare.name))
        return null;

    filterTable.filter = new Ast.BooleanExpression.And(null, [filterTable.filter, dontcare]).optimize();
    return clone;
}

module.exports = {
    // consistency checks
    POLICY_NAME,
    INITIAL_CONTEXT_INFO,
    checkStateIsValid,

    // system state manipulation
    makeSimpleState,

    // helpers
    getContextInfo,
    isUserAskingResultQuestion,
    isQueryAnswerValidForQuestion,
    isValidNegativePreambleForInfo,
    isFilterCompatibleWithResult,
    isInfoPhraseCompatibleWithResult,
    checkInfoPhrase,
    checkFilterPairForDisjunctiveQuestion,
    getActionInvocation,

    // system dialogue acts
    checkSearchResultPreamble,
    makeActionRecommendation,
    makeRecommendation,
    checkRecommendation,
    makeShortUserQuestionAnswer,
    checkListProposal,
    checkActionForRecommendation,
    makeRefinementProposal,

    // user dialogue acts
    mergePreambleAndRequest,
    initialRequest,
    refineFilterToAnswerQuestion,
    refineFilterToChangeFilter,

    // templates
    preciseSearchQuestionAnswer,
    impreciseSearchQuestionAnswerPair,
    impreciseSearchQuestionAnswer,
    proposalReplyPair,
    negativeRecommendationReplyPair,
    positiveRecommendationReplyPair,
    recommendationSearchQuestionPair,
    recommendationCancelPair,
    negativeListProposalReplyPair,
    positiveListProposalReplyPair,
    listProposalSearchQuestionPair,
    emptySearchChangePair,
    addDontCare,
};

