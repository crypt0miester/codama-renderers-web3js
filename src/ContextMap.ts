// In web3.js, we don't use a context pattern like UMI
// Instead, we pass specific objects like Connection, Keypair, etc.
// This class helps track what dependencies an instruction needs

export type Web3Dependency =
    | 'connection'    // Connection object for RPC
    | 'payer'        // Keypair for paying fees
    | 'programs'     // Program registry (if used)
    | 'signers';     // Additional signers

export class ContextMap {
    protected readonly _interfaces: Set<Web3Dependency> = new Set();

    add(dependency: Web3Dependency | Web3Dependency[]): ContextMap {
        if (Array.isArray(dependency)) {
            dependency.forEach(i => this._interfaces.add(i));
        } else {
            this._interfaces.add(dependency);
        }
        return this;
    }

    remove(dependency: Web3Dependency | Web3Dependency[]): ContextMap {
        if (Array.isArray(dependency)) {
            dependency.forEach(i => this._interfaces.delete(i));
        } else {
            this._interfaces.delete(dependency);
        }
        return this;
    }

    mergeWith(...others: ContextMap[]): ContextMap {
        others.forEach(other => this.add([...other._interfaces]));
        return this;
    }

    isEmpty(): boolean {
        return this._interfaces.size === 0;
    }

    toString(): string {
        // For web3.js, we don't use a Context type
        // Instructions just need Connection and sometimes additional parameters
        if (this._interfaces.size === 0) {
            return '';
        }

        // In the instruction context, we primarily need Connection
        // Other dependencies are passed as separate parameters
        const hasConnection = this._interfaces.has('connection');
        const hasPayer = this._interfaces.has('payer');
        const hasPrograms = this._interfaces.has('programs');

        // For now, we'll just track if Connection is needed
        // since that's the main dependency for web3.js operations
        if (hasConnection || hasPayer || hasPrograms) {
            return 'Connection';
        }

        return '';
    }
}