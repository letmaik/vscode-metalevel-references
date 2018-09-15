import { ExtensionContext, workspace, window, Disposable, commands, Uri } from 'vscode'

import { NAMESPACE } from './constants'
import { ReferenceTreeDataProvider, FileElement, FolderElement } from './treeProvider'

export function activate(context: ExtensionContext) {
    const disposables: Disposable[] = []
    context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()))

    const outputChannel = window.createOutputChannel('Metalevel References')
    disposables.push(outputChannel)

    const provider = new ReferenceTreeDataProvider(outputChannel)
    let treeView = window.createTreeView(
        NAMESPACE,
        {treeDataProvider: provider}
    )
    disposables.push(treeView)

    // The only purpose is to make the tree view visible, but there is no separate function for that.
    provider.onDidChangeTreeData(() => treeView.reveal(provider.treeRoot, {
        select: false, focus: false
    }))

    commands.registerCommand(NAMESPACE + '.findReferencesByFile', async (node: Uri|FileElement|undefined) => {
        if (!node) {
            return
        }
        let uri = node instanceof FileElement ? node.uri : node
        try {
            await provider.findReferencesByFile(uri)
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
        }
    })
    commands.registerCommand(NAMESPACE + '.findReferencesByFolder', async (node: Uri|FolderElement|undefined) => {
        if (!node) {
            return
        }
        let uri = node instanceof FolderElement ? node.uri : node
        try {
            await provider.findReferencesByFolder(uri)
        } catch (e) {
            console.error(e)
            window.showErrorMessage(e.message)
        }
    })
    commands.registerCommand(NAMESPACE + '.openFile', async node => {
        if (!node) {
            return
        }
        commands.executeCommand('vscode.open', node.uri);
    })
}
