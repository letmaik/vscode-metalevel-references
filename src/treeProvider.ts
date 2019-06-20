import * as path from 'path'
import * as fs from 'fs'
import * as commonPathPrefix from 'common-path-prefix'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState,
         Uri,  Disposable, EventEmitter, Event, TextDocumentShowOptions,
         ProgressLocation, OutputChannel,
         workspace, commands, SymbolInformation, DocumentSymbol, 
         Location, SymbolKind, FileType, Range, window  } from 'vscode'

class SourceElement {
    constructor(public label: string, public uri: Uri, public children: (FolderElement|FileElement)[]) {}
}

export class FolderElement {
    constructor(public label: string, public uri: Uri, public children: FileElement[]) {}
}

export class FileElement {
    constructor(public label: string, public uri: Uri, public children: SymbolReferenceElement[]) {}
}

class SymbolReferenceElement {
    children = []
    constructor(public label: string, public uri: Uri, public range: Range, public kind: SymbolKind) {}
}

type Element = SourceElement | FolderElement | FileElement | SymbolReferenceElement

class SymbolReferences {
    constructor(public symbol: SymbolInformation, public references: Location[]) {}

    filterUri(fn: (uri: Uri) => boolean) {
        return new SymbolReferences(this.symbol, this.references.filter(reference => fn(reference.uri)))
    }
}

export class ReferenceTreeDataProvider implements TreeDataProvider<Element>, Disposable {

    private _onDidChangeTreeData: EventEmitter<Element | undefined> = new EventEmitter<Element | undefined>()
    readonly onDidChangeTreeData: Event<Element | undefined> = this._onDidChangeTreeData.event

    private readonly disposables: Disposable[] = []

    public treeRoot: SourceElement

    constructor(private outputChannel: OutputChannel) {
    }

    private log(msg: string, error: Error | undefined=undefined) {
        if (error) {
            msg = `${msg}: ${error.message}`
        }
        this.outputChannel.appendLine(msg)
    }

    getTreeItem(element: Element): TreeItem {
        let label = element.label
        let collapsibleState = element.children.length === 0 ? TreeItemCollapsibleState.None : 
            (element instanceof SourceElement ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.Collapsed)
        const item = new TreeItem(label, collapsibleState)
        if (element instanceof SymbolReferenceElement) {
            let options: TextDocumentShowOptions = { selection: element.range }
            item.command = {
                command: 'vscode.open',
                arguments: [element.uri, options],
                title: ''
            }
        } else {
            item.resourceUri = element.uri
        }
        if (element instanceof FileElement) {
            item.contextValue = 'file'
        } else if (element instanceof FolderElement) {
            item.contextValue = 'folder'
        } else if (element instanceof SourceElement) {
            item.contextValue = 'source'
        }
        return item
    }

    getParent() {
        // we only call reveal() on the root item
        return null
    }

    async getChildren(element?: Element): Promise<Element[]> {
        if (!element) {
            return [this.treeRoot]
        } else {
            return element.children
        }
    }

    async findReferencesByFile(uri: Uri) {
        await window.withProgress({ location: ProgressLocation.Window, title: 'Fetching References' }, async p => {
            let fileSymbolReferences = await this.getFileSymbolReferences(uri)
            this.showInTree(uri, fileSymbolReferences)
        })
    }

    async findReferencesByFolder(uri: Uri) {
        await window.withProgress({ location: ProgressLocation.Window, title: 'Fetching References' }, async p => {
            let fileUris = getFilesRecursive(uri)
            let promises = fileUris.map(async fileUri => await this.getFileSymbolReferences(fileUri))
            let folderSymbolReferences: SymbolReferences[] = []
            let failures: any[] = []
            await Promise.all(promises.map(promise => 
                promise.then(fileSymbolReferences => {
                    for (let symbolReferences of fileSymbolReferences) {
                        let symbolExternalReferences = symbolReferences.filterUri(
                            symRefUri => !symRefUri.path.startsWith(uri.path + '/'))
                        if (symbolExternalReferences.references.length > 0) {
                            folderSymbolReferences.push(symbolExternalReferences)
                        }
                    }
                }).catch(e => {
                    this.log(e.message)
                    failures.push(e)
                })
            ))
            if (failures.length === fileUris.length) {
                throw new Error(`Could not retrieve symbols/references for any file in ` +
                    `${uri.fsPath}, first error was: ${failures[0].message}`)
            }
            this.showInTree(uri, folderSymbolReferences)
        })
    }

    showInTree(sourceUri: Uri, referencesBySymbol: SymbolReferences[]) {
        let referencesByFile = this.groupReferencesByFile(referencesBySymbol)
        this.log(`Found external references for ${referencesBySymbol.length} symbols ` +
            `in ${referencesByFile.size} files for ${sourceUri.fsPath}`)
        
        let workspaceFolders = workspace.workspaceFolders!
        let showWorkspaceFolder = workspaceFolders.length > 1
        
        let getShortPath = (uri: Uri) => {
            let root = workspace.getWorkspaceFolder(uri)
            if (!root) {
                throw new Error(`Could not determine workspace folder for ${uri}`)
            }
            let short = uri.fsPath.substring(root.uri.fsPath.length + 1).replace(/\\/g, '/')
            if (showWorkspaceFolder) {
                short = root.name + '/' + short
            }
            return short
        }
        
        let sourceShort = getShortPath(sourceUri)
        let sortedFiles = [...referencesByFile.keys()].sort()
        let uris = sortedFiles.map(Uri.parse)
        let filesShort = sortedFiles.map(file => getShortPath(Uri.parse(file)))
        filesShort.push(sourceShort)
        let commonPrefix: string = commonPathPrefix(filesShort, '/')
        if (commonPrefix.length > 0) {
            filesShort = filesShort.map(name => '...' + name.substring(commonPrefix.length))
        }
        sourceShort = filesShort.pop()!
        
        let sourceChildren: (FolderElement|FileElement)[] = []
        for (let i = 0; i < referencesByFile.size; i++) {
            let file = sortedFiles[i]
            let uri = uris[i]
            let short = filesShort[i]
            let references = referencesByFile.get(file)!
            let symbolEls = references.map(([symbol,range]) => 
                new SymbolReferenceElement(`Line ${range.start.line+1}: ${symbol.name}`,
                    uri, range, symbol.kind))
            let fileEl = new FileElement(short, uri, symbolEls)
            sourceChildren.push(fileEl)
        }
        
        this.treeRoot = new SourceElement(sourceShort, sourceUri, sourceChildren)
        this._onDidChangeTreeData.fire()
    }

    groupReferencesByFile(symbolsReferences: SymbolReferences[]): Map<string,[SymbolInformation,Range][]> {
        let grouped = new Map<string,[SymbolInformation,Range][]>()

        for (let {symbol, references} of symbolsReferences) {
            for (let reference of references) {
                let cacheKey = reference.uri.toString()
                let referencesInFile: [SymbolInformation, Range][]
                if (!grouped.has(cacheKey)) {
                    grouped.set(cacheKey, [])
                }
                referencesInFile = grouped.get(cacheKey)!
                referencesInFile.push([symbol, reference.range])
            }
        }
        return grouped
    }

    async getFileSymbolReferences(uri: Uri): Promise<SymbolReferences[]> {
        let symbols = await this.getFileSymbols(uri)
        let importantSymbols = getImportantSymbols(symbols)
        this.log(`${symbols.length} (after filter: ${importantSymbols.length}) symbols retrieved for ${uri.fsPath}`)
        if (importantSymbols.length === 0) {
            this.log(`Unfiltered symbols: ${symbols.map(s => `${s.name} [${SymbolKind[s.kind]}]`)}`)
        }
        let promises = importantSymbols.map(async symbol => 
                new SymbolReferences(symbol, await this.getSymbolReferences(symbol)))
        let fileSymbolReferences: SymbolReferences[] = []
        await Promise.all(promises.map(promise => 
            promise.then(symbolReferences => {
                let symbolExternalReferences = symbolReferences.filterUri(
                    symRefUri => symRefUri.path !== uri.path)
                if (symbolExternalReferences.references.length > 0) {
                    fileSymbolReferences.push(symbolExternalReferences)
                }
            }).catch(e => {
                this.log(e.message)
            })
        ))
        return fileSymbolReferences
    }

    symbolCache = new Map<string,SymbolInformation[]>()

    async getFileSymbols(file: Uri): Promise<SymbolInformation[]> {
        let cacheKey = file.toString()
        let cached = this.symbolCache.get(cacheKey)
        if (cached) {
            this.log(`Using cached symbols for ${file.fsPath}`)
            return cached
        }
        this.log(`Fetching symbols for ${file.fsPath}`)
        // Need to open document, otherwise provider throws "Illegal argument: resource"
        await workspace.openTextDocument(file)
        let result = await commands.executeCommand('vscode.executeDocumentSymbolProvider', file)
        if (!result) {
            throw new Error(`Could not retrieve symbols for ${file.fsPath}`)
        }
        const symbols = result as SymbolInformation[] | DocumentSymbol[]
        let symInfos: SymbolInformation[]
        if (symbols.length && 'children' in symbols[0]) {
            const todo = symbols as DocumentSymbol[]
            symInfos = new Array<SymbolInformation>()
            while (todo.length) {
                const symbol = todo.pop() as DocumentSymbol
                const location = new Location(file, symbol.selectionRange)
                const symInfo = new SymbolInformation(symbol.name, symbol.kind, '', location)
                symInfos.push(symInfo)
                todo.unshift(...symbol.children)
            }
        } else {
            symInfos = symbols as SymbolInformation[]
        }
        this.symbolCache.set(cacheKey, symInfos)
        return symInfos
    }

    symbolReferencesCache = new Map<string,(Location[]|Error)>()

    async getSymbolReferences(symbol: SymbolInformation): Promise<Location[]> {
        let uri = symbol.location.uri
        let range = symbol.location.range
        let cacheKey = `${uri}#${range.start.line}:${range.start.character}`
        let cached = this.symbolReferencesCache.get(cacheKey)
        if (Array.isArray(cached)) {
            this.log(`Using cached references for "${symbol.name}" in ${uri.fsPath}`)
            return cached
        } else if (cached instanceof Error) {
            this.log(`Ignoring symbol "${symbol.name}" in ${uri.fsPath} due to previous error`)
            throw cached
        }
        let document = await workspace.openTextDocument(uri)
        let text = document.getText(range)
        let simpleName = getSimpleSymbolName(symbol.name)
        let symbolOffsetInRange = text.indexOf(simpleName)
        if (symbolOffsetInRange === -1) {
            let error = new Error(`Symbol name "${simpleName}" (original: "${symbol.name}") not found in symbol range ` +
                `[${range.start.line+1}:${range.start.character+1}, ${range.end.line+1}:${range.end.character+1}] ` +
                `in ${uri.fsPath}`)
            this.symbolReferencesCache.set(cacheKey, error)
            throw error
        }
        let rangeOffset = document.offsetAt(range.start)
        let position = document.positionAt(rangeOffset + symbolOffsetInRange)
        this.log(`Fetching references for "${simpleName}" (original: "${symbol.name}") ` +
            `at ${position.line+1}:${position.character+1} in ${uri.fsPath}`)
        let result = await commands.executeCommand('vscode.executeReferenceProvider', uri, position)
        if (!result) {
            throw new Error(`Could not retrieve symbol references for "${simpleName}" in ${uri.fsPath}`)
        }
        let references = result as Location[]
        this.symbolReferencesCache.set(cacheKey, references)
        return references
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
    }
}

function getSimpleSymbolName(name: string): string {
    // C# provider always returns the full canonical name,
    // however the source code nearly always contains the simple name.
    name = name.split('.').slice(-1)[0]

    // C++ provider includes part of the function signature,
    // but we only want the function name. 
    name = name.split('(')[0]

    return name
}

// "Method" is not included as this often is an inherited/interface method
// which would yield unrelated references of the superclass/interface.
// This is a compromise, ideally there should be more intelligence to not
// miss out symbols and hence references.
const importantSymbolKinds = new Set([
    SymbolKind.Class, SymbolKind.Interface, SymbolKind.Enum, SymbolKind.Function
])

function getImportantSymbols(symbols: SymbolInformation[]): SymbolInformation[] {
    return symbols.filter(sym => importantSymbolKinds.has(sym.kind))
}

function getFilesRecursive(uri: Uri): Uri[] {
    let entries = readDirectory(uri)
    
    let children: Uri[] = []
    for (let [name, fileType] of entries) {
        let childUri = uri.with({ path: uri.path + '/' + name })
        if (fileType == FileType.File) {
            children.push(childUri)
        } else if (fileType == FileType.Directory) {
            children.push(...getFilesRecursive(childUri))
        } else {
            console.log(`Ignoring ${childUri}, unsupported file type`)
        }
    }
    return children
}

// Currently there is no access to the active FileSystemProvider.
// The readDirectory function mirrors the FileSystemProvider API
// so that a future replacement is easy.
function readDirectory(uri: Uri): [string, FileType][] {
    if (uri.scheme !== 'file') {
        throw new Error(`Unsupported scheme: ${uri}`)
    }
    let basePath = uri.fsPath
    let names = fs.readdirSync(basePath)
    let result = names.map(name => 
        [name, getFileType(path.join(basePath, name))] as [string, FileType])
    return result
}

function getFileType(fsPath: string): FileType {
    let stat = fs.lstatSync(fsPath)
    if (stat.isDirectory()) {
        return FileType.Directory
    } else if (stat.isFile()) {
        return FileType.File
    } else if (stat.isSymbolicLink()) {
        return FileType.SymbolicLink
    } else {
        return FileType.Unknown
    }
}
