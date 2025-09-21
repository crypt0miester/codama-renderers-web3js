/* eslint-disable no-case-declarations */
import { camelCase, InstructionInputValueNode, isNode, OptionalAccountStrategy, pascalCase } from '@codama/nodes';
import { ResolvedInstructionInput, visit } from '@codama/visitors-core';

import { ContextMap } from './ContextMap';
import { getTypeManifestVisitor } from './getTypeManifestVisitor';
import { ImportMap } from './ImportMap';
import { GetImportFromFunction } from './utils';

export function renderInstructionDefaults(
    input: ResolvedInstructionInput,
    typeManifestVisitor: ReturnType<typeof getTypeManifestVisitor>,
    optionalAccountStrategy: OptionalAccountStrategy,
    argObject: string,
    getImportFrom: GetImportFromFunction,
): {
    imports: ImportMap;
    interfaces: ContextMap;
    render: string;
} {
    const imports = new ImportMap();
    const interfaces = new ContextMap();

    if (!input.defaultValue) {
        return { imports, interfaces, render: '' };
    }

    const { defaultValue } = input;
    const render = (
        renderedValue: string,
        isWritable?: boolean,
        isSigner?: boolean,
    ): {
        imports: ImportMap;
        interfaces: ContextMap;
        render: string;
    } => {
        const inputName = camelCase(input.name);
        if (input.kind === 'instructionAccountNode' && isNode(defaultValue, 'resolverValueNode')) {
            return {
                imports,
                interfaces,
                render: `resolvedAccounts.${inputName} = { ...resolvedAccounts.${inputName}, ...${renderedValue} };`,
            };
        }
        if (input.kind === 'instructionAccountNode' && isWritable === undefined && isSigner === undefined) {
            return {
                imports,
                interfaces,
                render: `resolvedAccounts.${inputName}.value = ${renderedValue};`,
            };
        }
        if (input.kind === 'instructionAccountNode') {
            const updates: string[] = [`resolvedAccounts.${inputName}.value = ${renderedValue}`];
            if (isWritable !== undefined) {
                updates.push(`resolvedAccounts.${inputName}.isWritable = ${isWritable ? 'true' : 'false'}`);
            }
            if (isSigner !== undefined) {
                updates.push(`resolvedAccounts.${inputName}.isSigner = ${isSigner ? 'true' : 'false'}`);
            }
            return {
                imports,
                interfaces,
                render: updates.join(';\n'),
            };
        }
        return {
            imports,
            interfaces,
            render: `${argObject}.${inputName} = ${renderedValue};`,
        };
    };

    switch (defaultValue.kind) {
        case 'accountValueNode':
            const name = camelCase(defaultValue.name);
            if (input.kind === 'instructionAccountNode') {
                imports.add('shared', 'expectSome');
                if (input.resolvedIsSigner && !input.isSigner) {
                    return render(`expectSome(resolvedAccounts.${name}.value).publicKey`);
                }
                return render(`expectSome(resolvedAccounts.${name}.value)`);
            }
            imports.add('shared', 'expectPublicKey');
            return render(`expectPublicKey(resolvedAccounts.${name}.value)`);
        case 'pdaValueNode':
            // Inlined PDA value.
            if (isNode(defaultValue.pda, 'pdaNode')) {
                const pdaProgram = defaultValue.pda.programId
                    ? `new PublicKey('${defaultValue.pda.programId}')`
                    : 'programId';
                const pdaSeeds = defaultValue.pda.seeds.flatMap((seed): string[] => {
                    if (isNode(seed, 'constantPdaSeedNode') && isNode(seed.value, 'programIdValueNode')) {
                        return [`${pdaProgram}.toBuffer()`];
                    }
                    if (isNode(seed, 'constantPdaSeedNode') && !isNode(seed.value, 'programIdValueNode')) {
                        const typeManifest = visit(seed.type, typeManifestVisitor);
                        const valueManifest = visit(seed.value, typeManifestVisitor);

                        // For PublicKey types, use toBuffer()
                        if (typeManifest.looseType === 'PublicKey') {
                            imports.mergeWith(valueManifest.valueImports);
                            return [`${valueManifest.value}.toBuffer()`];
                        }
                        // For bytes/Uint8Array types, use Buffer.from()
                        if (typeManifest.looseType === 'Uint8Array' || typeManifest.looseType.includes('Uint8Array')) {
                            imports.mergeWith(valueManifest.valueImports);
                            return [`Buffer.from(${valueManifest.value})`];
                        }
                        // For other types, use the serializer
                        imports.mergeWith(typeManifest.serializerImports);
                        imports.mergeWith(valueManifest.valueImports);
                        return [`${typeManifest.serializer}.encode(${valueManifest.value})`];
                    }
                    if (isNode(seed, 'variablePdaSeedNode')) {
                        const typeManifest = visit(seed.type, typeManifestVisitor);
                        const valueSeed = defaultValue.seeds.find(s => s.name === seed.name)?.value;
                        if (!valueSeed) return [];
                        if (isNode(valueSeed, 'accountValueNode')) {
                            imports.add('shared', 'expectPublicKey');
                            // For PublicKey types, use toBuffer()
                            if (typeManifest.looseType === 'PublicKey') {
                                return [`expectPublicKey(resolvedAccounts.${camelCase(valueSeed.name)}.value).toBuffer()`];
                            }
                            // For bytes types, don't need expectPublicKey
                            if (typeManifest.looseType === 'Uint8Array' || typeManifest.looseType.includes('Uint8Array')) {
                                imports.add('shared', 'expectSome');
                                return [`Buffer.from(expectSome(resolvedAccounts.${camelCase(valueSeed.name)}.value))`];
                            }
                            imports.mergeWith(typeManifest.serializerImports);
                            return [
                                `${typeManifest.serializer}.encode(expectPublicKey(resolvedAccounts.${camelCase(valueSeed.name)}.value))`,
                            ];
                        }
                        if (isNode(valueSeed, 'argumentValueNode')) {
                            imports.add('shared', 'expectSome');
                            // For PublicKey types, use toBuffer()
                            if (typeManifest.looseType === 'PublicKey') {
                                return [`expectSome(${argObject}.${camelCase(valueSeed.name)}).toBuffer()`];
                            }
                            // For bytes types, use Buffer.from()
                            if (typeManifest.looseType === 'Uint8Array' || typeManifest.looseType.includes('Uint8Array')) {
                                return [`Buffer.from(expectSome(${argObject}.${camelCase(valueSeed.name)}))`];
                            }
                            imports.mergeWith(typeManifest.serializerImports);
                            return [
                                `${typeManifest.serializer}.encode(expectSome(${argObject}.${camelCase(valueSeed.name)}))`,
                            ];
                        }
                        const valueManifest = visit(valueSeed, typeManifestVisitor);
                        // For PublicKey types, use toBuffer()
                        if (typeManifest.looseType === 'PublicKey') {
                            imports.mergeWith(valueManifest.valueImports);
                            return [`${valueManifest.value}.toBuffer()`];
                        }
                        // For bytes types, use Buffer.from()
                        if (typeManifest.looseType === 'Uint8Array' || typeManifest.looseType.includes('Uint8Array')) {
                            imports.mergeWith(valueManifest.valueImports);
                            return [`Buffer.from(${valueManifest.value})`];
                        }
                        imports.mergeWith(typeManifest.serializerImports);
                        imports.mergeWith(valueManifest.valueImports);
                        return [`${typeManifest.serializer}.encode(${valueManifest.value})`];
                    }
                    return [];
                });

                imports.add('web3', 'PublicKey');
                return render(`PublicKey.findProgramAddressSync([${pdaSeeds.join(', ')}], ${pdaProgram})[0]`);
            }

            // Linked PDA value.
            const pdaFunction = `find${pascalCase(defaultValue.pda.name)}Pda`;
            imports.add(getImportFrom(defaultValue.pda), pdaFunction);
            // PDA generation doesn't need extra interfaces in web3.js
            const pdaArgs = ['programId'];
            const pdaSeeds = defaultValue.seeds.map((seed): string => {
                if (isNode(seed.value, 'accountValueNode')) {
                    imports.add('shared', 'expectPublicKey');
                    return `${seed.name}: expectPublicKey(resolvedAccounts.${camelCase(seed.value.name)}.value)`;
                }
                if (isNode(seed.value, 'argumentValueNode')) {
                    imports.add('shared', 'expectSome');
                    return `${seed.name}: expectSome(${argObject}.${camelCase(seed.value.name)})`;
                }
                const valueManifest = visit(seed.value, typeManifestVisitor);
                imports.mergeWith(valueManifest.valueImports);
                return `${seed.name}: ${valueManifest.value}`;
            });
            if (pdaSeeds.length > 0) {
                pdaArgs.push(`{ ${pdaSeeds.join(', ')} }`);
            }
            return render(`${pdaFunction}(${pdaArgs.join(', ')})`);
        case 'publicKeyValueNode':
            imports.add('web3', 'PublicKey');
            return render(`new PublicKey('${defaultValue.publicKey}')`);
        case 'programLinkNode':
            const functionName = `get${pascalCase(defaultValue.name)}ProgramId`;
            imports.add(getImportFrom(defaultValue), functionName);
            return render(`${functionName}()`, false);
        case 'programIdValueNode':
            if (
                optionalAccountStrategy === 'programId' &&
                input.kind === 'instructionAccountNode' &&
                input.isOptional
            ) {
                return { imports, interfaces, render: '' };
            }
            return render('programId', false);
        case 'identityValueNode':
            // In web3.js, identity/payer must be provided explicitly - no default
            // The instruction function doesn't have access to payer context
            return { imports, interfaces, render: '' };
        case 'payerValueNode':
            // In web3.js, payer must be provided explicitly - no default
            // The instruction function doesn't have access to payer context
            return { imports, interfaces, render: '' };
        case 'accountBumpValueNode':
            imports.add('shared', 'expectPda');
            return render(`expectPda(resolvedAccounts.${camelCase(defaultValue.name)}.value)[1]`);
        case 'argumentValueNode':
            imports.add('shared', 'expectSome');
            return render(`expectSome(${argObject}.${camelCase(defaultValue.name)})`);
        case 'resolverValueNode':
            const resolverName = camelCase(defaultValue.name);
            const isWritable = input.kind === 'instructionAccountNode' && input.isWritable ? 'true' : 'false';
            imports.add(getImportFrom(defaultValue), resolverName);
            interfaces.add(['connection', 'payer']);
            return render(`${resolverName}(resolvedAccounts, ${argObject}, programId, ${isWritable})`);
        case 'conditionalValueNode':
            const ifTrueRenderer = renderNestedInstructionDefault(
                input,
                typeManifestVisitor,
                optionalAccountStrategy,
                defaultValue.ifTrue,
                argObject,
                getImportFrom,
            );
            const ifFalseRenderer = renderNestedInstructionDefault(
                input,
                typeManifestVisitor,
                optionalAccountStrategy,
                defaultValue.ifFalse,
                argObject,
                getImportFrom,
            );
            if (!ifTrueRenderer && !ifFalseRenderer) {
                return { imports, interfaces, render: '' };
            }
            if (ifTrueRenderer) {
                imports.mergeWith(ifTrueRenderer.imports);
                interfaces.mergeWith(ifTrueRenderer.interfaces);
            }
            if (ifFalseRenderer) {
                imports.mergeWith(ifFalseRenderer.imports);
                interfaces.mergeWith(ifFalseRenderer.interfaces);
            }
            const negatedCondition = !ifTrueRenderer;
            let condition = 'true';

            if (isNode(defaultValue.condition, 'resolverValueNode')) {
                const conditionalResolverName = camelCase(defaultValue.condition.name);
                const conditionalIsWritable =
                    input.kind === 'instructionAccountNode' && input.isWritable ? 'true' : 'false';
                imports.add(getImportFrom(defaultValue.condition), conditionalResolverName);
                interfaces.add(['connection', 'payer']);
                condition = `${conditionalResolverName}(resolvedAccounts, ${argObject}, programId, ${conditionalIsWritable})`;
                condition = negatedCondition ? `!${condition}` : condition;
            } else {
                const comparedInputName = isNode(defaultValue.condition, 'accountValueNode')
                    ? `resolvedAccounts.${camelCase(defaultValue.condition.name)}.value`
                    : `${argObject}.${camelCase(defaultValue.condition.name)}`;
                if (defaultValue.value) {
                    const comparedValue = visit(defaultValue.value, typeManifestVisitor);
                    imports.mergeWith(comparedValue.valueImports);
                    const operator = negatedCondition ? '!==' : '===';
                    condition = `${comparedInputName} ${operator} ${comparedValue.value}`;
                } else {
                    condition = negatedCondition ? `!${comparedInputName}` : comparedInputName;
                }
            }

            if (ifTrueRenderer && ifFalseRenderer) {
                return {
                    imports,
                    interfaces,
                    render: `if (${condition}) {\n${ifTrueRenderer.render}\n} else {\n${ifFalseRenderer.render}\n}`,
                };
            }

            return {
                imports,
                interfaces,
                render: `if (${condition}) {\n${ifTrueRenderer ? ifTrueRenderer.render : ifFalseRenderer?.render}\n}`,
            };
        default:
            const valueManifest = visit(defaultValue, typeManifestVisitor);
            imports.mergeWith(valueManifest.valueImports);
            return render(valueManifest.value);
    }
}

function renderNestedInstructionDefault(
    input: ResolvedInstructionInput,
    typeManifestVisitor: ReturnType<typeof getTypeManifestVisitor>,
    optionalAccountStrategy: OptionalAccountStrategy,
    defaultValue: InstructionInputValueNode | undefined,
    argObject: string,
    getImportFrom: GetImportFromFunction,
):
    | {
          imports: ImportMap;
          interfaces: ContextMap;
          render: string;
      }
    | undefined {
    if (!defaultValue) return undefined;
    return renderInstructionDefaults(
        { ...input, defaultValue },
        typeManifestVisitor,
        optionalAccountStrategy,
        argObject,
        getImportFrom,
    );
}
