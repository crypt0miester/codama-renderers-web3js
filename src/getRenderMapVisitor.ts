import { logWarn } from '@codama/errors';
import {
    camelCase,
    CamelCaseString,
    definedTypeNode,
    FieldDiscriminatorNode,
    getAllAccounts,
    getAllDefinedTypes,
    getAllInstructionArguments,
    getAllInstructionsWithSubs,
    getAllPrograms,
    InstructionNode,
    isDataEnum,
    isNode,
    isNodeFilter,
    kebabCase,
    parseOptionalAccountStrategy,
    pascalCase,
    ProgramNode,
    resolveNestedTypeNode,
    SizeDiscriminatorNode,
    structTypeNodeFromInstructionArgumentNodes,
    VALUE_NODES,
} from '@codama/nodes';
import { addToRenderMap, createRenderMap, mergeRenderMaps, RenderMap } from '@codama/renderers-core';
import {
    extendVisitor,
    getByteSizeVisitor,
    getResolvedInstructionInputsVisitor,
    LinkableDictionary,
    NodeStack,
    pipe,
    recordLinkablesOnFirstVisitVisitor,
    recordNodeStackVisitor,
    ResolvedInstructionAccount,
    ResolvedInstructionInput,
    staticVisitor,
    visit,
    Visitor,
} from '@codama/visitors-core';

import { ContextMap } from './ContextMap';
import { getTypeManifestVisitor } from './getTypeManifestVisitor';
import { ImportMap } from './ImportMap';
import { renderInstructionDefaults } from './renderInstructionDefaults';
import {
    CustomDataOptions,
    getDefinedTypeNodesToExtract,
    getGpaFieldsFromAccount,
    getImportFromFactory,
    LinkOverrides,
    parseCustomDataOptions,
    render,
} from './utils';

export type GetRenderMapOptions = {
    customAccountData?: CustomDataOptions[];
    customInstructionData?: CustomDataOptions[];
    dependencyMap?: Record<string, string>;
    internalNodes?: string[];
    linkOverrides?: LinkOverrides;
    nonScalarEnums?: string[];
    renderParentInstructions?: boolean;
};

export function getRenderMapVisitor(options: GetRenderMapOptions = {}): Visitor<RenderMap> {
    const linkables = new LinkableDictionary();
    const stack = new NodeStack();
    let program: ProgramNode | null = null;

    const renderParentInstructions = options.renderParentInstructions ?? false;
    const dependencyMap = {
        generated: '..',
        hooked: '../../hooked',
        web3: '@solana/web3.js',
        borsh: '@coral-xyz/borsh',
        'buffer-layout': 'buffer-layout',
        buffer: 'buffer',
        ...options.dependencyMap,

        // Custom relative dependencies to link generated files together.
        generatedAccounts: '../accounts',
        generatedErrors: '../errors',
        generatedInstructions: '../instructions',
        generatedPrograms: '../programs',
        generatedTypes: '../types',
    };
    const nonScalarEnums = (options.nonScalarEnums ?? []).map(camelCase);
    const internalNodes = (options.internalNodes ?? []).map(camelCase);
    const customAccountData = parseCustomDataOptions(options.customAccountData ?? [], 'AccountData');
    const customInstructionData = parseCustomDataOptions(options.customInstructionData ?? [], 'InstructionData');
    const getImportFrom = getImportFromFactory(options.linkOverrides ?? {}, customAccountData, customInstructionData);

    const typeManifestVisitor = getTypeManifestVisitor({
        customAccountData,
        customInstructionData,
        getImportFrom,
        linkables,
        nonScalarEnums,
        stack,
    });
    const resolvedInstructionInputVisitor = getResolvedInstructionInputsVisitor();
    const byteSizeVisitor = getByteSizeVisitor(linkables, { stack });

    function getInstructionAccountType(_account: ResolvedInstructionAccount): string { 
        return 'PublicKey';
    }


    function getMergeConflictsForInstructionAccountsAndArgs(instruction: InstructionNode): string[] {
        const allNames = [
            ...instruction.accounts.map(account => account.name),
            ...instruction.arguments.map(field => field.name),
            ...(instruction.extraArguments ?? []).map(field => field.name),
        ];
        const duplicates = allNames.filter((e, i, a) => a.indexOf(e) !== i);
        return [...new Set(duplicates)];
    }

    return pipe(
        staticVisitor(() => createRenderMap()),
        v =>
            extendVisitor(v, {
                visitAccount(node) {
                    const customData = customAccountData.get(node.name);
                    const isLinked = !!customData;
                    const typeManifest = visit(node, typeManifestVisitor);
                    const imports = new ImportMap().mergeWith(
                        typeManifest.strictImports,
                        typeManifest.serializerImports,
                    );
                    if (!isLinked) {
                        imports.mergeWith(typeManifest.looseImports);
                    }
                    imports
                        .add('web3', [
                            'AccountInfo',
                            'Connection',
                            'PublicKey',
                            'GetAccountInfoConfig',
                            'GetMultipleAccountsConfig',
                            'GetProgramAccountsFilter',
                        ])
                        .add('borsh', !isLinked ? ['Layout'] : [])
                        .add('buffer', ['Buffer']);

                    // Discriminator.
                    const discriminator =
                        (node.discriminators ?? []).find(d => !isNode(d, 'constantDiscriminatorNode')) ?? null;
                    let resolvedDiscriminator:
                        | SizeDiscriminatorNode
                        | (FieldDiscriminatorNode & { value: string })
                        | null = null;
                    if (isNode(discriminator, 'fieldDiscriminatorNode')) {
                        const discriminatorField = resolveNestedTypeNode(node.data).fields.find(
                            f => f.name === discriminator.name,
                        );
                        const discriminatorValue = discriminatorField?.defaultValue
                            ? visit(discriminatorField.defaultValue, typeManifestVisitor)
                            : undefined;
                        if (discriminatorValue) {
                            imports.mergeWith(discriminatorValue.valueImports);
                            resolvedDiscriminator = {
                                ...discriminator,
                                value: discriminatorValue.value,
                            };
                        }
                    } else if (isNode(discriminator, 'sizeDiscriminatorNode')) {
                        resolvedDiscriminator = discriminator;
                    }

                    // GPA Fields.
                    const gpaFields = getGpaFieldsFromAccount(node, byteSizeVisitor).map(gpaField => {
                        const gpaFieldManifest = visit(gpaField.type, typeManifestVisitor);
                        imports.mergeWith(gpaFieldManifest.looseImports, gpaFieldManifest.serializerImports);
                        return { ...gpaField, manifest: gpaFieldManifest };
                    });
                    let resolvedGpaFields: { argument: string; type: string } | null = null;
                    if (gpaFields.length > 0) {
                        imports.add('web3', ['Connection']);
                        resolvedGpaFields = {
                            argument: `{ ${gpaFields
                                .map(f => {
                                    const offset = f.offset === null ? 'null' : `${f.offset}`;
                                    return `'${f.name}': [${offset}, ${f.manifest.serializer}]`;
                                })
                                .join(', ')} }`,
                            type: `{ ${gpaFields.map(f => `'${f.name}': ${f.manifest.looseType}`).join(', ')} }`,
                        };
                    }

                    // Seeds.
                    const pda = node.pda ? linkables.get([...stack.getPath(), node.pda]) : undefined;
                    const pdaSeeds = pda?.seeds ?? [];
                    const seeds = pdaSeeds.map(seed => {
                        if (isNode(seed, 'variablePdaSeedNode')) {
                            const seedManifest = visit(seed.type, typeManifestVisitor);
                            imports.mergeWith(seedManifest.looseImports, seedManifest.serializerImports);
                            return { ...seed, typeManifest: seedManifest };
                        }
                        if (isNode(seed.value, 'programIdValueNode')) {
                            imports.add('web3', 'PublicKey');
                            return seed;
                        }
                        const seedManifest = visit(seed.type, typeManifestVisitor);
                        imports.mergeWith(seedManifest.serializerImports);
                        const valueManifest = visit(seed.value, typeManifestVisitor);
                        imports.mergeWith(valueManifest.valueImports);
                        return { ...seed, typeManifest: seedManifest, valueManifest };
                    });
                    if (seeds.length > 0) {
                        imports.add('web3', ['PublicKey']);
                    }
                    const hasVariableSeeds = pdaSeeds.filter(isNodeFilter('variablePdaSeedNode')).length > 0;

                    return createRenderMap(
                        `accounts/${camelCase(node.name)}.ts`,
                        render('accountsPage.njk', {
                            account: node,
                            customData,
                            discriminator: resolvedDiscriminator,
                            gpaFields: resolvedGpaFields,
                            hasVariableSeeds,
                            imports: imports.toString(dependencyMap),
                            program,
                            seeds,
                            typeManifest,
                        }),
                    );
                },

                visitDefinedType(node) {
                    const pascalCaseName = pascalCase(node.name);
                    const typeManifest = visit(node, typeManifestVisitor);
                    const imports = new ImportMap()
                        .mergeWithManifest(typeManifest)
                        .add('borsh', ['Layout'])
                        .remove('generatedTypes', [
                            pascalCaseName,
                            `${pascalCaseName}Args`,
                            `get${pascalCaseName}Layout`,
                        ]);

                    return createRenderMap(
                        `types/${camelCase(node.name)}.ts`,
                        render('definedTypesPage.njk', {
                            definedType: node,
                            imports: imports.toString({
                                ...dependencyMap,
                                generatedTypes: '.',
                            }),
                            isDataEnum: isNode(node.type, 'enumTypeNode') && isDataEnum(node.type),
                            typeManifest,
                        }),
                    );
                },

                visitInstruction(node) {
                    // Imports and interfaces.
                    const interfaces = new ContextMap();
                    const imports = new ImportMap()
                        .add('web3', ['PublicKey', 'TransactionInstruction'])
                        .add('shared', ['ResolvedAccount', 'ResolvedAccountsWithIndices', 'getAccountMetasAndSigners']);

                    // Instruction helpers.
                    const customData = customInstructionData.get(node.name);
                    const linkedDataArgs = !!customData;
                    const hasAccounts = node.accounts.length > 0;
                    const hasData = linkedDataArgs || node.arguments.length > 0;
                    const hasDataArgs =
                        linkedDataArgs ||
                        node.arguments.filter(field => field.defaultValueStrategy !== 'omitted').length > 0;
                    const hasExtraArgs =
                        (node.extraArguments ?? []).filter(field => field.defaultValueStrategy !== 'omitted').length >
                        0;
                    const hasAnyArgs = hasDataArgs || hasExtraArgs;
                    const allArgumentsWithDefaultValue = [
                        ...node.arguments.filter(a => a.defaultValue && !isNode(a.defaultValue, VALUE_NODES)),
                        ...(node.extraArguments ?? []).filter(a => a.defaultValue),
                    ];
                    const hasArgDefaults = allArgumentsWithDefaultValue.length > 0;
                    const hasArgResolvers = allArgumentsWithDefaultValue.some(a =>
                        isNode(a.defaultValue, 'resolverValueNode'),
                    );
                    const hasAccountResolvers = node.accounts.some(a => isNode(a.defaultValue, 'resolverValueNode'));
                    const byteDelta = node.byteDeltas?.[0] ?? undefined;
                    const hasByteResolver = byteDelta && isNode(byteDelta.value, 'resolverValueNode');
                    let remainingAccounts = node.remainingAccounts?.[0] ?? undefined;
                    if (
                        remainingAccounts &&
                        isNode(remainingAccounts.value, 'argumentValueNode') &&
                        getAllInstructionArguments(node).every(arg => arg.name !== remainingAccounts?.value.name)
                    ) {
                        remainingAccounts = undefined;
                    }
                    const hasRemainingAccountsResolver =
                        remainingAccounts && isNode(remainingAccounts.value, 'resolverValueNode');
                    const hasResolvers =
                        hasArgResolvers || hasAccountResolvers || hasByteResolver || hasRemainingAccountsResolver;
                    const hasResolvedArgs = hasDataArgs || hasArgDefaults || hasResolvers;
                    if (hasResolvers) {
                        interfaces.add(['connection', 'payer']);
                    }

                    // Discriminator.
                    const discriminator =
                        (node.discriminators ?? []).find(d => !isNode(d, 'constantDiscriminatorNode')) ?? null;
                    let resolvedDiscriminator:
                        | (FieldDiscriminatorNode & { value: string })
                        | null = null;
                    if (isNode(discriminator, 'fieldDiscriminatorNode')) {
                        const discriminatorField = node.arguments.find(a => a.name === discriminator.name);
                        const discriminatorValue = discriminatorField?.defaultValue
                            ? visit(discriminatorField.defaultValue, typeManifestVisitor as any)
                            : undefined;   
                        if (discriminatorValue) {
                            resolvedDiscriminator = {
                                ...discriminator,
                                value: (discriminatorValue as any).value,
                            };
                        }
                    } 
                    // canMergeAccountsAndArgs
                    let canMergeAccountsAndArgs = false;
                    if (!linkedDataArgs) {
                        const accountsAndArgsConflicts = getMergeConflictsForInstructionAccountsAndArgs(node);
                        if (accountsAndArgsConflicts.length > 0) {
                            logWarn(
                                `[JavaScript] Accounts and args of instruction [${node.name}] have the following ` +
                                    `conflicting attributes [${accountsAndArgsConflicts.join(', ')}]. ` +
                                    `Thus, they could not be merged into a single input object. ` +
                                    'You may want to rename the conflicting attributes.',
                            );
                        }
                        canMergeAccountsAndArgs = accountsAndArgsConflicts.length === 0;
                    }

                    // Resolved inputs.
                    let argObject = canMergeAccountsAndArgs ? 'input' : 'args';
                    argObject = hasResolvedArgs ? 'resolvedArgs' : argObject;
                    const resolvedInputs = visit(node, resolvedInstructionInputVisitor).map(
                        (input: ResolvedInstructionInput) => {
                            const renderedInput = renderInstructionDefaults(
                                input,
                                typeManifestVisitor,
                                parseOptionalAccountStrategy(node.optionalAccountStrategy),
                                argObject,
                                getImportFrom,
                            );
                            imports.mergeWith(renderedInput.imports);
                            interfaces.mergeWith(renderedInput.interfaces);
                            return { ...input, render: renderedInput.render };
                        },
                    );
                    const resolvedInputsWithDefaults = resolvedInputs.filter(
                        input => input.defaultValue !== undefined && input.render !== '',
                    );
                    // Add isSome import when we have defaults
                    if (resolvedInputsWithDefaults.length > 0) {
                        imports.add('shared', 'isSome');
                    }
                    const argsWithDefaults = resolvedInputsWithDefaults
                        .filter(isNodeFilter('instructionArgumentNode'))
                        .map(input => input.name);

                    // Accounts.
                    const accounts = node.accounts.map(account => {
                        const hasDefaultValue = !!account.defaultValue;
                        const resolvedAccount = resolvedInputs.find(
                            input => input.kind === 'instructionAccountNode' && input.name === account.name,
                        ) as ResolvedInstructionAccount;
                        return {
                            ...resolvedAccount,
                            hasDefaultValue,
                            optionalSign: hasDefaultValue || account.isOptional ? '?' : '',
                            type: getInstructionAccountType(resolvedAccount),
                        };
                    });
                    // Add web3.js types for accounts
                    if (accounts.length > 0) {
                        imports.add('web3', ['PublicKey']);
                    }
                    if (program) {
                        // Add program ID import
                        const programIdConstant = `${program.name.toUpperCase().replace(/-/g, '_')}_PROGRAM_ID`;
                        imports.add(`../programs/${kebabCase(program.name)}`, programIdConstant);
                    }


                    // Data Args.
                    const dataArgManifest = visit(node, typeManifestVisitor);
                    if (linkedDataArgs || hasData) {
                        imports.mergeWith(dataArgManifest.looseImports, dataArgManifest.serializerImports);
                    }
                    if (!linkedDataArgs) {
                        imports.mergeWith(dataArgManifest.strictImports);
                    }
                    if (!linkedDataArgs && hasData) {
                        imports.add('borsh', ['Layout']);
                    }

                    // Extra args.
                    const extraArgStruct = definedTypeNode({
                        name: `${node.name}InstructionExtra`,
                        type: structTypeNodeFromInstructionArgumentNodes(node.extraArguments ?? []),
                    });
                    const extraArgManifest = visit(extraArgStruct, typeManifestVisitor);
                    imports.mergeWith(extraArgManifest.looseImports);

                    // Arg defaults.
                    allArgumentsWithDefaultValue.forEach(argument => {
                        if (isNode(argument.defaultValue, 'resolverValueNode')) {
                            imports.add(getImportFrom(argument.defaultValue), camelCase(argument.defaultValue.name));
                        }
                    });
                    if (argsWithDefaults.length > 0) {
                        imports.add('shared', ['PickPartial']);
                    }

                    // Bytes created on chain - not used in web3.js templates
                    // These imports are kept for compatibility but not actually used
                    if (byteDelta && isNode(byteDelta.value, 'accountLinkNode')) {
                        const accountName = pascalCase(byteDelta.value.name);
                        imports.add(getImportFrom(byteDelta.value), `get${accountName}Size`);
                    } else if (byteDelta && isNode(byteDelta.value, 'resolverValueNode')) {
                        imports.add(getImportFrom(byteDelta.value), camelCase(byteDelta.value.name));
                    }

                    // Remaining accounts.
                    if (remainingAccounts && isNode(remainingAccounts.value, 'resolverValueNode')) {
                        imports.add(getImportFrom(remainingAccounts.value), camelCase(remainingAccounts.value.name));
                    }

                    return createRenderMap(
                        `instructions/${camelCase(node.name)}.ts`,
                        render('instructionsPage.njk', {
                            accounts,
                            argsWithDefaults,
                            byteDelta,
                            canMergeAccountsAndArgs,
                            customData,
                            dataArgManifest,
                            extraArgManifest,
                            hasAccountResolvers,
                            hasAccounts,
                            hasAnyArgs,
                            hasArgDefaults,
                            hasArgResolvers,
                            hasByteResolver,
                            instructionDiscriminator: resolvedDiscriminator,
                            hasData,
                            hasDataArgs,
                            hasExtraArgs,
                            hasRemainingAccountsResolver,
                            hasResolvedArgs,
                            hasResolvers,
                            imports: imports.toString(dependencyMap),
                            instruction: node,
                            interfaces: interfaces.toString(),
                            program,
                            remainingAccounts,
                            resolvedInputs,
                            resolvedInputsWithDefaults,
                        }),
                    );
                },

                visitProgram(node, { self }) {
                    program = node;
                    const customDataDefinedType = [
                        ...getDefinedTypeNodesToExtract(node.accounts, customAccountData),
                        ...getDefinedTypeNodesToExtract(node.instructions, customInstructionData),
                    ];
                    const renders = pipe(
                        mergeRenderMaps([
                            ...node.accounts.map(a => visit(a, self)),
                            ...node.definedTypes.map(t => visit(t, self)),
                            ...customDataDefinedType.map(t => visit(t, self)),
                            ...getAllInstructionsWithSubs(node, {
                                leavesOnly: !renderParentInstructions,
                            }).map(ix => visit(ix, self)),
                        ]),
                        r =>
                            addToRenderMap(
                                r,
                                `errors/${camelCase(node.name)}.ts`,
                                render('errorsPage.njk', {
                                    errors: node.errors,
                                    imports: new ImportMap()
                                        .add('web3', ['PublicKey'])
                                        .toString(dependencyMap),
                                    program: node,
                                }),
                            ),
                        r =>
                            addToRenderMap(
                                r,
                                `programs/${camelCase(node.name)}.ts`,
                                render('programsPage.njk', {
                                    imports: new ImportMap()
                                        .add('web3', ['PublicKey'])
                                        .toString(dependencyMap),
                                    program: node,
                                }),
                            ),
                    );
                    program = null;
                    return renders;
                },

                visitRoot(node, { self }) {
                    const isNotInternal = (n: { name: CamelCaseString }) => !internalNodes.includes(n.name);
                    const programsToExport = getAllPrograms(node).filter(isNotInternal);
                    const accountsToExport = getAllAccounts(node).filter(isNotInternal);
                    const instructionsToExport = getAllInstructionsWithSubs(node, {
                        leavesOnly: !renderParentInstructions,
                    }).filter(isNotInternal);
                    const definedTypesToExport = getAllDefinedTypes(node).filter(isNotInternal);
                    const hasAnythingToExport =
                        programsToExport.length > 0 ||
                        accountsToExport.length > 0 ||
                        instructionsToExport.length > 0 ||
                        definedTypesToExport.length > 0;

                    const ctx = {
                        accountsToExport,
                        definedTypesToExport,
                        hasAnythingToExport,
                        instructionsToExport,
                        programsToExport,
                        root: node,
                    };

                    return mergeRenderMaps([
                        createRenderMap({
                            ['accounts/index.ts']:
                                accountsToExport.length > 0 ? render('accountsIndex.njk', ctx) : undefined,
                            ['errors/index.ts']:
                                programsToExport.length > 0 ? render('errorsIndex.njk', ctx) : undefined,
                            ['index.ts']: render('rootIndex.njk', ctx),
                            ['instructions/index.ts']:
                                instructionsToExport.length > 0 ? render('instructionsIndex.njk', ctx) : undefined,
                            ['programs/index.ts']:
                                programsToExport.length > 0 ? render('programsIndex.njk', ctx) : undefined,
                            ['shared/index.ts']: hasAnythingToExport ? render('sharedPage.njk', ctx) : undefined,
                            ['types/buffer-layout/index.d.ts']: hasAnythingToExport ? render('bufferLayoutTypes.njk', ctx) : undefined,
                            ['types/index.ts']:
                                definedTypesToExport.length > 0 ? render('definedTypesIndex.njk', ctx) : undefined,
                        }),
                        ...getAllPrograms(node).map(p => visit(p, self)),
                    ]);
                },
            }),
        v => recordNodeStackVisitor(v, stack),
        v => recordLinkablesOnFirstVisitVisitor(v, linkables),
    );
}
