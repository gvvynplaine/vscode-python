// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { nbformat } from '@jupyterlab/coreutils';
import { assert, use } from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { ReactWrapper } from 'enzyme';
import { EventEmitter } from 'events';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as sinon from 'sinon';
import * as TypeMoq from 'typemoq';
import { Disposable, TextDocument, TextEditor, Uri } from 'vscode';
import { IApplicationShell, ICustomEditorService, IDocumentManager } from '../../client/common/application/types';
import { IFileSystem } from '../../client/common/platform/types';
import { createDeferred, sleep, waitForPromise } from '../../client/common/utils/async';
import { noop } from '../../client/common/utils/misc';
import { Identifiers } from '../../client/datascience/constants';
import { DataScienceErrorHandler } from '../../client/datascience/errorHandler/errorHandler';
import { InteractiveWindowMessages } from '../../client/datascience/interactive-common/interactiveWindowTypes';
import { JupyterExecutionFactory } from '../../client/datascience/jupyter/jupyterExecutionFactory';
import { ICell, IDataScienceErrorHandler, IJupyterExecution, INotebookEditorProvider, INotebookExporter } from '../../client/datascience/types';
import { PythonInterpreter } from '../../client/interpreter/contracts';
import { Editor } from '../../datascience-ui/interactive-common/editor';
import { NativeCell } from '../../datascience-ui/native-editor/nativeCell';
import { NativeEditor } from '../../datascience-ui/native-editor/nativeEditor';
import { IKeyboardEvent } from '../../datascience-ui/react-common/event';
import { ImageButton } from '../../datascience-ui/react-common/imageButton';
import { IMonacoEditorState, MonacoEditor } from '../../datascience-ui/react-common/monacoEditor';
import { createTemporaryFile } from '../utils/fs';
import { DataScienceIocContainer } from './dataScienceIocContainer';
import { MockCustomEditorService } from './mockCustomEditorService';
import { MockDocumentManager } from './mockDocumentManager';
import { addCell, closeNotebook, createNewEditor, getNativeCellResults, mountNativeWebView, openEditor, runMountedTest, setupWebview } from './nativeEditorTestHelpers';
import { waitForUpdate } from './reactHelpers';
import {
    addContinuousMockData,
    addMockData,
    CellPosition,
    enterEditorKey,
    escapePath,
    findButton,
    getLastOutputCell,
    getNativeFocusedEditor,
    getOutputCell,
    injectCode,
    isCellFocused,
    isCellMarkdown,
    isCellSelected,
    srcDirectory,
    typeCode,
    verifyCellIndex,
    verifyHtmlOnCell,
    waitForMessage,
    waitForMessageResponse
} from './testHelpers';

use(chaiAsPromised);

//import { asyncDump } from '../common/asyncDump';
// tslint:disable:max-func-body-length trailing-comma no-any no-multiline-string
suite('DataScience Native Editor', () => {
    function createFileCell(cell: any, data: any): ICell {
        const newCell = { type: 'preview', id: 'FakeID', file: Identifiers.EmptyFileName, line: 0, state: 2, ...cell };
        newCell.data = { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '', ...data };

        return newCell;
    }
    suite('Editor tests', () => {
        const disposables: Disposable[] = [];
        let ioc: DataScienceIocContainer;

        setup(async () => {
            ioc = new DataScienceIocContainer();
            ioc.registerDataScienceTypes();

            const appShell = TypeMoq.Mock.ofType<IApplicationShell>();
            appShell.setup(a => a.showErrorMessage(TypeMoq.It.isAnyString())).returns(_e => Promise.resolve(''));
            appShell.setup(a => a.showInformationMessage(TypeMoq.It.isAny(), TypeMoq.It.isAny())).returns(() => Promise.resolve(''));
            appShell
                .setup(a => a.showInformationMessage(TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                .returns((_a1: string, a2: string, _a3: string) => Promise.resolve(a2));
            appShell
                .setup(a => a.showInformationMessage(TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny(), TypeMoq.It.isAny()))
                .returns((_a1: string, _a2: any, _a3: string, a4: string) => Promise.resolve(a4));
            appShell.setup(a => a.showSaveDialog(TypeMoq.It.isAny())).returns(() => Promise.resolve(Uri.file('foo.ipynb')));
            ioc.serviceManager.rebindInstance<IApplicationShell>(IApplicationShell, appShell.object);
        });

        teardown(async () => {
            for (const disposable of disposables) {
                if (!disposable) {
                    continue;
                }
                // tslint:disable-next-line:no-any
                const promise = disposable.dispose() as Promise<any>;
                if (promise) {
                    await promise;
                }
            }
            await ioc.dispose();
        });

        // Uncomment this to debug hangs on exit
        // suiteTeardown(() => {
        //      asyncDump();
        // });

        runMountedTest(
            'Simple text',
            async wrapper => {
                // Create an editor so something is listening to messages
                await createNewEditor(ioc);

                // Add a cell into the UI and wait for it to render
                await addCell(wrapper, ioc, 'a=1\na');

                verifyHtmlOnCell(wrapper, 'NativeCell', '<span>1</span>', 1);
            },
            () => {
                return ioc;
            }
        );

        runMountedTest(
            'Mime Types',
            async wrapper => {
                // Create an editor so something is listening to messages
                await createNewEditor(ioc);

                const badPanda = `import pandas as pd
df = pd.read("${escapePath(path.join(srcDirectory(), 'DefaultSalesReport.csv'))}")
df.head()`;
                const goodPanda = `import pandas as pd
df = pd.read_csv("${escapePath(path.join(srcDirectory(), 'DefaultSalesReport.csv'))}")
df.head()`;
                const matPlotLib = 'import matplotlib.pyplot as plt\r\nimport numpy as np\r\nx = np.linspace(0,20,100)\r\nplt.plot(x, np.sin(x))\r\nplt.show()';
                const matPlotLibResults = 'img';
                const spinningCursor = `import sys
import time
def spinning_cursor():
    while True:
        for cursor in '|/-\\\\':
            yield cursor
spinner = spinning_cursor()
for _ in range(50):
    sys.stdout.write(next(spinner))
    sys.stdout.flush()
    time.sleep(0.1)
    sys.stdout.write('\\r')`;
                const alternating = `from IPython.display import display\r\nprint('foo')\r\ndisplay('foo')\r\nprint('bar')\r\ndisplay('bar')`;
                const alternatingResults = ['foo\n', 'foo', 'bar\n', 'bar'];

                const clearalternating = `from IPython.display import display, clear_output\r\nprint('foo')\r\ndisplay('foo')\r\nclear_output(True)\r\nprint('bar')\r\ndisplay('bar')`;
                const clearalternatingResults = ['foo\n', 'foo', '', 'bar\n', 'bar'];

                addMockData(ioc, badPanda, `pandas has no attribute 'read'`, 'text/html', 'error');
                addMockData(ioc, goodPanda, `<td>A table</td>`, 'text/html');
                addMockData(ioc, matPlotLib, matPlotLibResults, 'text/html');
                addMockData(ioc, alternating, alternatingResults, ['text/plain', 'stream', 'text/plain', 'stream']);
                addMockData(ioc, clearalternating, clearalternatingResults, ['text/plain', 'stream', 'clear_true', 'text/plain', 'stream']);
                const cursors = ['|', '/', '-', '\\'];
                let cursorPos = 0;
                let loops = 3;
                addContinuousMockData(ioc, spinningCursor, async _c => {
                    const result = `${cursors[cursorPos]}\r`;
                    cursorPos += 1;
                    if (cursorPos >= cursors.length) {
                        cursorPos = 0;
                        loops -= 1;
                    }
                    return Promise.resolve({ result: result, haveMore: loops > 0 });
                });

                await addCell(wrapper, ioc, badPanda, true);
                verifyHtmlOnCell(wrapper, 'NativeCell', `has no attribute 'read'`, CellPosition.Last);

                await addCell(wrapper, ioc, goodPanda, true);
                verifyHtmlOnCell(wrapper, 'NativeCell', `<td>`, CellPosition.Last);

                await addCell(wrapper, ioc, matPlotLib, true);
                verifyHtmlOnCell(wrapper, 'NativeCell', /img|Figure/, CellPosition.Last);

                await addCell(wrapper, ioc, spinningCursor, true);
                verifyHtmlOnCell(wrapper, 'NativeCell', '<div>', CellPosition.Last);

                await addCell(wrapper, ioc, alternating, true);
                verifyHtmlOnCell(wrapper, 'NativeCell', /.*foo\n.*foo.*bar\n.*bar/m, CellPosition.Last);
                await addCell(wrapper, ioc, clearalternating, true);
                verifyHtmlOnCell(wrapper, 'NativeCell', /.*bar\n.*bar/m, CellPosition.Last);
            },
            () => {
                return ioc;
            }
        );

        runMountedTest(
            'Click buttons',
            async wrapper => {
                // Goto source should cause the visible editor to be picked as long as its filename matches
                const showedEditor = createDeferred();
                const textEditors: TextEditor[] = [];
                const docManager = TypeMoq.Mock.ofType<IDocumentManager>();
                const visibleEditor = TypeMoq.Mock.ofType<TextEditor>();
                const dummyDocument = TypeMoq.Mock.ofType<TextDocument>();
                dummyDocument.setup(d => d.fileName).returns(() => Uri.file('foo.py').fsPath);
                visibleEditor.setup(v => v.show()).returns(() => showedEditor.resolve());
                visibleEditor.setup(v => v.revealRange(TypeMoq.It.isAny())).returns(noop);
                visibleEditor.setup(v => v.document).returns(() => dummyDocument.object);
                textEditors.push(visibleEditor.object);
                docManager.setup(a => a.visibleTextEditors).returns(() => textEditors);
                ioc.serviceManager.rebindInstance<IDocumentManager>(IDocumentManager, docManager.object);
                // Create an editor so something is listening to messages
                await createNewEditor(ioc);

                // Get a cell into the list
                await addCell(wrapper, ioc, 'a=1\na');

                // find the buttons on the cell itself
                let cell = getLastOutputCell(wrapper, 'NativeCell');
                let ImageButtons = cell.find(ImageButton);
                assert.equal(ImageButtons.length, 6, 'Cell buttons not found');
                let deleteButton = ImageButtons.at(5);

                // Make sure delete works
                let afterDelete = await getNativeCellResults(ioc, wrapper, async () => {
                    deleteButton.simulate('click');
                    return Promise.resolve();
                });
                assert.equal(afterDelete.length, 1, `Delete should remove a cell`);

                // Secondary delete should NOT delete the cell as there should ALWAYS be at
                // least one cell in the file.
                cell = getLastOutputCell(wrapper, 'NativeCell');
                ImageButtons = cell.find(ImageButton);
                assert.equal(ImageButtons.length, 6, 'Cell buttons not found');
                deleteButton = ImageButtons.at(5);

                afterDelete = await getNativeCellResults(
                    ioc,
                    wrapper,
                    async () => {
                        deleteButton.simulate('click');
                        return Promise.resolve();
                    },
                    () => waitForUpdate(wrapper, NativeEditor, 1)
                );
                assert.equal(afterDelete.length, 1, `Delete should NOT remove the last cell`);
            },
            () => {
                return ioc;
            }
        );

        runMountedTest(
            'Select Jupyter Server',
            async _wrapper => {
                // tslint:disable-next-line: no-console
                console.log('Test skipped until user can change jupyter server selection again');
                // let selectorCalled = false;

                // ioc.datascience.setup(ds => ds.selectJupyterURI()).returns(() => {
                //     selectorCalled = true;
                //     return Promise.resolve();
                // });

                // await createNewEditor(ioc);
                // const editor = wrapper.find(NativeEditor);
                // const kernelSelectionUI = editor.find(KernelSelection);
                // const buttons = kernelSelectionUI.find('div');
                // buttons!.at(1).simulate('click');

                // assert.equal(selectorCalled, true, 'Server Selector should have been called');
            },
            () => {
                return ioc;
            }
        );

        runMountedTest(
            'Select Jupyter Kernel',
            async _wrapper => {
                // tslint:disable-next-line: no-console
                console.log('Tests skipped, as we need better tests');
                // let selectorCalled = false;

                // ioc.datascience.setup(ds => ds.selectLocalJupyterKernel()).returns(() => {
                //     selectorCalled = true;
                //     const spec: KernelSpecInterpreter = {};
                //     return Promise.resolve(spec);
                // });

                // await createNewEditor(ioc);
                // // Create an editor so something is listening to messages
                // await createNewEditor(ioc);

                // // Add a cell into the UI and wait for it to render
                // await addCell(wrapper, ioc, 'a=1\na');

                // const editor = wrapper.find(NativeEditor);
                // const kernelSelectionUI = editor.find(KernelSelection);
                // const buttons = kernelSelectionUI.find('div');
                // buttons!.at(4).simulate('click');

                // assert.equal(selectorCalled, true, 'Kernel Selector should have been called');
            },
            () => {
                return ioc;
            }
        );

        runMountedTest(
            'Server already loaded',
            async (_wrapper, context) => {
                if (ioc.mockJupyter) {
                    await ioc.activate();

                    // Create an editor so something is listening to messages
                    const editor = await createNewEditor(ioc);

                    // Wait a bit to let async activation to work
                    await sleep(500);

                    // Make sure it has a server
                    assert.ok(editor.notebook, 'Notebook did not start with a server');
                } else {
                    context.skip();
                }
                // Do the same thing again, but disable auto start
                ioc.getSettings().datascience.disableJupyterAutoStart = true;
            },
            () => {
                return ioc;
            }
        );

        runMountedTest(
            'Server load skipped',
            async (_wrapper, context) => {
                if (ioc.mockJupyter) {
                    ioc.getSettings().datascience.disableJupyterAutoStart = true;
                    await ioc.activate();

                    // Create an editor so something is listening to messages
                    const editor = await createNewEditor(ioc);

                    // Wait a bit to let async activation to work
                    await sleep(500);

                    // Make sure it does not have a server
                    assert.notOk(editor.notebook, 'Notebook should not start with a server');
                } else {
                    context.skip();
                }
            },
            () => {
                return ioc;
            }
        );

        runMountedTest(
            'Convert to python',
            async wrapper => {
                // Export should cause the export dialog to come up. Remap appshell so we can check
                const dummyDisposable = {
                    dispose: () => {
                        return;
                    }
                };
                const appShell = TypeMoq.Mock.ofType<IApplicationShell>();
                appShell
                    .setup(a => a.showErrorMessage(TypeMoq.It.isAnyString()))
                    .returns(e => {
                        throw e;
                    });
                appShell.setup(a => a.showInformationMessage(TypeMoq.It.isAny(), TypeMoq.It.isAny())).returns(() => Promise.resolve(''));
                appShell
                    .setup(a => a.showSaveDialog(TypeMoq.It.isAny()))
                    .returns(() => {
                        return Promise.resolve(undefined);
                    });
                appShell.setup(a => a.setStatusBarMessage(TypeMoq.It.isAny())).returns(() => dummyDisposable);
                ioc.serviceManager.rebindInstance<IApplicationShell>(IApplicationShell, appShell.object);

                // Make sure to create the interactive window after the rebind or it gets the wrong application shell.
                await createNewEditor(ioc);
                await addCell(wrapper, ioc, 'a=1\na');

                // Export should cause exportCalled to change to true
                const saveButton = findButton(wrapper, NativeEditor, 8);
                const saved = waitForMessage(ioc, InteractiveWindowMessages.NotebookClean);
                await waitForMessageResponse(ioc, () => saveButton!.simulate('click'));
                await saved;

                // Click export and wait for a document to change
                const activeTextEditorChange = createDeferred();
                const docManager = ioc.get<IDocumentManager>(IDocumentManager) as MockDocumentManager;
                docManager.onDidChangeActiveTextEditor(() => activeTextEditorChange.resolve());
                const exportButton = findButton(wrapper, NativeEditor, 9);
                await waitForMessageResponse(ioc, () => exportButton!.simulate('click'));

                // This can be slow, hence wait for a max of 60.
                await waitForPromise(activeTextEditorChange.promise, 60_000);

                // Verify the new document is valid python
                const newDoc = docManager.activeTextEditor;
                assert.ok(newDoc, 'New doc not created');
                assert.ok(newDoc!.document.getText().includes('a=1'), 'Export did not create a python file');
            },
            () => {
                return ioc;
            }
        );

        runMountedTest(
            'RunAllCells',
            async wrapper => {
                addMockData(ioc, 'b=2\nb', 2);
                addMockData(ioc, 'c=3\nc', 3);

                const baseFile = [
                    { id: 'NotebookImport#0', data: { source: 'a=1\na' } },
                    { id: 'NotebookImport#1', data: { source: 'b=2\nb' } },
                    { id: 'NotebookImport#2', data: { source: 'c=3\nc' } }
                ];
                const runAllCells = baseFile.map(cell => {
                    return createFileCell(cell, cell.data);
                });
                const notebook = await ioc.get<INotebookExporter>(INotebookExporter).translateToNotebook(runAllCells, undefined);
                await openEditor(ioc, JSON.stringify(notebook));

                const runAllButton = findButton(wrapper, NativeEditor, 0);
                // The render method needs to be executed 3 times for three cells.
                const threeCellsUpdated = waitForMessage(ioc, InteractiveWindowMessages.ExecutionRendered, { numberOfTimes: 3 });
                await waitForMessageResponse(ioc, () => runAllButton!.simulate('click'));
                await threeCellsUpdated;

                verifyHtmlOnCell(wrapper, 'NativeCell', `1`, 0);
                verifyHtmlOnCell(wrapper, 'NativeCell', `2`, 1);
                verifyHtmlOnCell(wrapper, 'NativeCell', `3`, 2);
            },
            () => {
                return ioc;
            }
        );

        runMountedTest(
            'Startup and shutdown',
            async wrapper => {
                // Stub the `stat` method to return a dummy value.
                try {
                    sinon.stub(ioc.serviceContainer.get<IFileSystem>(IFileSystem), 'stat').resolves({ mtime: 0 } as any);
                } catch (e) {
                    // tslint:disable-next-line: no-console
                    console.log(`Stub failure ${e}`);
                }

                addMockData(ioc, 'b=2\nb', 2);
                addMockData(ioc, 'c=3\nc', 3);

                const baseFile = [
                    { id: 'NotebookImport#0', data: { source: 'a=1\na' } },
                    { id: 'NotebookImport#1', data: { source: 'b=2\nb' } },
                    { id: 'NotebookImport#2', data: { source: 'c=3\nc' } }
                ];
                const runAllCells = baseFile.map(cell => {
                    return createFileCell(cell, cell.data);
                });
                const notebook = await ioc.get<INotebookExporter>(INotebookExporter).translateToNotebook(runAllCells, undefined);
                let editor = await openEditor(ioc, JSON.stringify(notebook));

                // Run everything
                let renderAll = waitForMessage(ioc, InteractiveWindowMessages.ExecutionRendered, { numberOfTimes: 3 });
                let runAllButton = findButton(wrapper, NativeEditor, 0);
                await waitForMessageResponse(ioc, () => runAllButton!.simulate('click'));
                await renderAll;

                // Close editor. Should still have the server up
                await closeNotebook(editor, wrapper);
                const jupyterExecution = ioc.serviceManager.get<IJupyterExecution>(IJupyterExecution);
                const editorProvider = ioc.serviceManager.get<INotebookEditorProvider>(INotebookEditorProvider);
                const server = await jupyterExecution.getServer(await editorProvider.getNotebookOptions());
                assert.ok(server, 'Server was destroyed on notebook shutdown');

                // Reopen, and rerun
                const newWrapper = await setupWebview(ioc);
                assert.ok(newWrapper, 'Could not mount a second time');
                editor = await openEditor(ioc, JSON.stringify(notebook));
                runAllButton = findButton(newWrapper!, NativeEditor, 0);
                renderAll = waitForMessage(ioc, InteractiveWindowMessages.ExecutionRendered, { numberOfTimes: 3 });
                await waitForMessageResponse(ioc, () => runAllButton!.simulate('click'));
                await renderAll;
                verifyHtmlOnCell(newWrapper!, 'NativeCell', `1`, 0);
            },
            () => {
                // Disable the warning displayed by nodejs when there are too many listeners.
                EventEmitter.defaultMaxListeners = 15;
                return ioc;
            }
        );

        test('Failure', async () => {
            let fail = true;
            const errorThrownDeferred = createDeferred<Error>();
            // Make a dummy class that will fail during launch
            class FailedProcess extends JupyterExecutionFactory {
                public getUsableJupyterPython(): Promise<PythonInterpreter | undefined> {
                    if (fail) {
                        return Promise.resolve(undefined);
                    }
                    return super.getUsableJupyterPython();
                }
            }

            class CustomErrorHandler extends DataScienceErrorHandler {
                public handleError(exc: Error): Promise<void> {
                    errorThrownDeferred.resolve(exc);
                    return Promise.resolve();
                }
            }
            ioc.serviceManager.rebind<IJupyterExecution>(IJupyterExecution, FailedProcess);
            ioc.serviceManager.rebind<IDataScienceErrorHandler>(IDataScienceErrorHandler, CustomErrorHandler);
            ioc.serviceManager.get<IJupyterExecution>(IJupyterExecution);
            addMockData(ioc, 'a=1\na', 1);
            const wrapper = mountNativeWebView(ioc);
            await createNewEditor(ioc);
            const result = await Promise.race([addCell(wrapper, ioc, 'a=1\na', true), errorThrownDeferred.promise]);
            assert.ok(result, 'Error not found');
            assert.ok(result instanceof Error, 'Error not found');

            // Fix failure and try again
            fail = false;
            const cell = getOutputCell(wrapper, 'NativeCell', 1);
            assert.ok(cell, 'Cannot find the first cell');
            const imageButtons = cell!.find(ImageButton);
            assert.equal(imageButtons.length, 6, 'Cell buttons not found');
            const runButton = imageButtons.findWhere(w => w.props().tooltip === 'Run cell');
            assert.equal(runButton.length, 1, 'No run button found');
            const update = waitForMessage(ioc, InteractiveWindowMessages.ExecutionRendered);
            runButton.simulate('click');
            await update;
            verifyHtmlOnCell(wrapper, 'NativeCell', `1`, 1);
        });
    });

    suite('Editor tests', () => {
        let wrapper: ReactWrapper<any, Readonly<{}>, React.Component>;
        const disposables: Disposable[] = [];
        let ioc: DataScienceIocContainer;
        const baseFile = `
{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": 1,
   "metadata": {
    "collapsed": true
   },
   "outputs": [
    {
     "data": {
      "text/plain": [
       "1"
      ]
     },
     "execution_count": 1,
     "metadata": {},
     "output_type": "execute_result"
    }
   ],
   "source": [
    "a=1\\n",
    "a"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": 2,
   "metadata": {},
   "outputs": [
    {
     "data": {
      "text/plain": [
       "2"
      ]
     },
     "execution_count": 2,
     "metadata": {},
     "output_type": "execute_result"
    }
   ],
   "source": [
    "b=2\\n",
    "b"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": 3,
   "metadata": {},
   "outputs": [
    {
     "data": {
      "text/plain": [
       "3"
      ]
     },
     "execution_count": 3,
     "metadata": {},
     "output_type": "execute_result"
    }
   ],
   "source": [
    "c=3\\n",
    "c"
   ]
  }
 ],
 "metadata": {
  "file_extension": ".py",
  "kernelspec": {
   "display_name": "Python 3",
   "language": "python",
   "name": "python3"
  },
  "language_info": {
   "codemirror_mode": {
    "name": "ipython",
    "version": 3
   },
   "file_extension": ".py",
   "mimetype": "text/x-python",
   "name": "python",
   "nbconvert_exporter": "python",
   "pygments_lexer": "ipython3",
   "version": "3.7.4"
  },
  "mimetype": "text/x-python",
  "name": "python",
  "npconvert_exporter": "python",
  "pygments_lexer": "ipython3",
  "version": 3
 },
 "nbformat": 4,
 "nbformat_minor": 2
}`;
        const addedJSON = JSON.parse(baseFile);
        addedJSON.cells.splice(3, 0, {
            cell_type: 'code',
            execution_count: null,
            metadata: {},
            outputs: [],
            source: []
        });

        let notebookFile: {
            filePath: string;
            cleanupCallback: Function;
        };
        function initIoc() {
            ioc = new DataScienceIocContainer();
            ioc.registerDataScienceTypes();
        }
        async function setupFunction(this: Mocha.Context, fileContents?: any) {
            const wrapperPossiblyUndefined = await setupWebview(ioc);
            if (wrapperPossiblyUndefined) {
                wrapper = wrapperPossiblyUndefined;

                addMockData(ioc, 'b=2\nb', 2);
                addMockData(ioc, 'c=3\nc', 3);
                // Use a real file so we can save notebook to a file.
                // This is used in some tests (saving).
                notebookFile = await createTemporaryFile('.ipynb');
                await fs.writeFile(notebookFile.filePath, fileContents ? fileContents : baseFile);
                await Promise.all([waitForUpdate(wrapper, NativeEditor, 1), openEditor(ioc, fileContents ? fileContents : baseFile, notebookFile.filePath)]);
            } else {
                // tslint:disable-next-line: no-invalid-this
                this.skip();
            }
        }

        teardown(async () => {
            for (const disposable of disposables) {
                if (!disposable) {
                    continue;
                }
                // tslint:disable-next-line:no-any
                const promise = disposable.dispose() as Promise<any>;
                if (promise) {
                    await promise;
                }
            }
            await ioc.dispose();
            try {
                notebookFile.cleanupCallback();
            } catch {
                noop();
            }
        });

        function clickCell(cellIndex: number) {
            wrapper.update();
            wrapper
                .find(NativeCell)
                .at(cellIndex)
                .simulate('click');
            wrapper.update();
        }

        function simulateKeyPressOnCell(cellIndex: number, keyboardEvent: Partial<IKeyboardEvent> & { code: string }) {
            // Check to see if we have an active focused editor
            const editor = getNativeFocusedEditor(wrapper);

            // If we do have one, send the input there, otherwise send it to the outer cell
            if (editor) {
                simulateKeyPressOnEditor(editor, keyboardEvent);
            } else {
                simulateKeyPressOnCellInner(cellIndex, keyboardEvent);
            }
        }

        function simulateKeyPressOnEditor(editorControl: ReactWrapper<any, Readonly<{}>, React.Component> | undefined, keyboardEvent: Partial<IKeyboardEvent> & { code: string }) {
            enterEditorKey(editorControl, keyboardEvent);
        }

        function simulateKeyPressOnCellInner(cellIndex: number, keyboardEvent: Partial<IKeyboardEvent> & { code: string }) {
            wrapper.update();
            let nativeCell = wrapper.find(NativeCell).at(cellIndex);
            if (nativeCell.exists()) {
                nativeCell.simulate('keydown', {
                    key: keyboardEvent.code,
                    shiftKey: keyboardEvent.shiftKey,
                    ctrlKey: keyboardEvent.ctrlKey,
                    altKey: keyboardEvent.altKey,
                    metaKey: keyboardEvent.metaKey
                });
            }
            wrapper.update();
            // Requery for our cell as something like a 'dd' keydown command can delete it before the press and up
            nativeCell = wrapper.find(NativeCell).at(cellIndex);
            if (nativeCell.exists()) {
                nativeCell.simulate('keypress', {
                    key: keyboardEvent.code,
                    shiftKey: keyboardEvent.shiftKey,
                    ctrlKey: keyboardEvent.ctrlKey,
                    altKey: keyboardEvent.altKey,
                    metaKey: keyboardEvent.metaKey
                });
            }
            nativeCell = wrapper.find(NativeCell).at(cellIndex);
            wrapper.update();
            if (nativeCell.exists()) {
                nativeCell.simulate('keyup', {
                    key: keyboardEvent.code,
                    shiftKey: keyboardEvent.shiftKey,
                    ctrlKey: keyboardEvent.ctrlKey,
                    altKey: keyboardEvent.altKey,
                    metaKey: keyboardEvent.metaKey
                });
            }
            wrapper.update();
        }

        suite('Selection/Focus', () => {
            setup(async function() {
                initIoc();
                // tslint:disable-next-line: no-invalid-this
                await setupFunction.call(this);
            });
            test('None of the cells are selected by default', async () => {
                assert.ok(!isCellSelected(wrapper, 'NativeCell', 0));
                assert.ok(!isCellSelected(wrapper, 'NativeCell', 1));
                assert.ok(!isCellSelected(wrapper, 'NativeCell', 2));
            });

            test('None of the cells are not focused by default', async () => {
                assert.ok(!isCellFocused(wrapper, 'NativeCell', 0));
                assert.ok(!isCellFocused(wrapper, 'NativeCell', 1));
                assert.ok(!isCellFocused(wrapper, 'NativeCell', 2));
            });

            test('Select cells by clicking them', async () => {
                // Click first cell, then second, then third.
                clickCell(0);
                assert.ok(isCellSelected(wrapper, 'NativeCell', 0));
                assert.equal(isCellSelected(wrapper, 'NativeCell', 1), false);
                assert.equal(isCellSelected(wrapper, 'NativeCell', 2), false);

                clickCell(1);
                assert.ok(isCellSelected(wrapper, 'NativeCell', 1));
                assert.equal(isCellSelected(wrapper, 'NativeCell', 0), false);
                assert.equal(isCellSelected(wrapper, 'NativeCell', 2), false);

                clickCell(2);
                assert.ok(isCellSelected(wrapper, 'NativeCell', 2));
                assert.equal(isCellSelected(wrapper, 'NativeCell', 0), false);
                assert.equal(isCellSelected(wrapper, 'NativeCell', 1), false);
            });

            test('Markdown saved when selecting another cell', async () => {
                clickCell(0);

                // Switch to markdown
                let update = waitForMessage(ioc, InteractiveWindowMessages.FocusedCellEditor);
                simulateKeyPressOnCell(0, { code: 'm' });
                await update;

                // Monaco editor should be rendered and the cell should be markdown
                assert.ok(isCellFocused(wrapper, 'NativeCell', 0));
                assert.ok(isCellMarkdown(wrapper, 'NativeCell', 0));
                assert.equal(
                    wrapper
                        .find(NativeCell)
                        .at(0)
                        .find(MonacoEditor).length,
                    1
                );

                // Verify cell content
                const currentEditor = getNativeFocusedEditor(wrapper);
                const reactEditor = currentEditor!.instance() as MonacoEditor;
                const editor = reactEditor.state.editor;
                if (editor) {
                    assert.equal(editor.getModel()!.getValue(), 'a=1\na', 'Incorrect editor text in markdown cell');
                }

                typeCode(currentEditor, 'world');

                if (editor) {
                    assert.equal(editor.getModel()!.getValue(), 'worlda=1\na', 'Incorrect editor text in markdown cell');
                }

                // Now get the editor for the next cell and click it
                update = waitForUpdate(wrapper, NativeEditor, 1);
                clickCell(1);
                await update;

                // Look back at the output for the first cell, not focused, not selected, text saved in output
                assert.equal(isCellSelected(wrapper, 'NativeCell', 0), false);
                assert.equal(isCellFocused(wrapper, 'NativeCell', 0), false);

                verifyHtmlOnCell(wrapper, 'NativeCell', '<p>worlda=1\na</p>', 0);
            });
        });

        suite('Model updates', () => {
            setup(async function() {
                initIoc();
                // tslint:disable-next-line: no-invalid-this
                await setupFunction.call(this);
            });
            async function undo(): Promise<void> {
                const uri = Uri.file(notebookFile.filePath);
                const update = waitForMessage(ioc, InteractiveWindowMessages.ReceivedUpdateModel);
                const editorService = ioc.serviceManager.get<ICustomEditorService>(ICustomEditorService) as MockCustomEditorService;
                editorService.undo(uri);
                return update;
            }
            async function redo(): Promise<void> {
                const uri = Uri.file(notebookFile.filePath);
                const update = waitForMessage(ioc, InteractiveWindowMessages.ReceivedUpdateModel);
                const editorService = ioc.serviceManager.get<ICustomEditorService>(ICustomEditorService) as MockCustomEditorService;
                editorService.redo(uri);
                return update;
            }
            test('Add a cell and undo', async () => {
                addMockData(ioc, 'c=4\nc', '4');
                await addCell(wrapper, ioc, 'c=4\nc', false);

                // Should have 4 cells
                assert.equal(wrapper.find('NativeCell').length, 4, 'Cell not added');

                // Send undo through the custom editor
                await undo();

                // Should have 3
                assert.equal(wrapper.find('NativeCell').length, 3, 'Cell not removed');
            });
            test('Edit a cell and undo', async () => {
                await addCell(wrapper, ioc, '', false);

                // Should have 4 cells
                assert.equal(wrapper.find('NativeCell').length, 4, 'Cell not added');

                // Change the contents of the cell
                const editorEnzyme = getNativeFocusedEditor(wrapper);

                // Type in something with brackets
                typeCode(editorEnzyme, 'some more');

                // Verify cell content
                const reactEditor = editorEnzyme!.instance() as MonacoEditor;
                const editor = reactEditor.state.editor;
                if (editor) {
                    assert.equal(editor.getModel()!.getValue(), 'some more', 'Text does not match');
                }

                // Add a new cell
                await addCell(wrapper, ioc, '', false);

                // Send undo a bunch of times. Should undo the add and the edits
                await undo();
                await undo();
                await undo();

                // Should have four again
                assert.equal(wrapper.find('NativeCell').length, 4, 'Cell not removed on undo');

                // Should have different content
                if (editor) {
                    assert.equal(editor.getModel()!.getValue(), 'some mo', 'Text does not match after undo');
                }

                // Send redo to see if goes back
                await redo();
                if (editor) {
                    assert.equal(editor.getModel()!.getValue(), 'some mor', 'Text does not match');
                }

                // Send redo to see if goes back
                await redo();
                await redo();
                assert.equal(wrapper.find('NativeCell').length, 5, 'Cell not readded on redo');
            });
            test('Remove, move, and undo', async () => {
                await addCell(wrapper, ioc, '', false);

                // Should have 4 cells
                assert.equal(wrapper.find('NativeCell').length, 4, 'Cell not added');

                // Delete the cell
                let cell = getLastOutputCell(wrapper, 'NativeCell');
                let imageButtons = cell.find(ImageButton);
                assert.equal(imageButtons.length, 6, 'Cell buttons not found');
                const deleteButton = imageButtons.at(5);
                await getNativeCellResults(ioc, wrapper, async () => {
                    deleteButton.simulate('click');
                    return Promise.resolve();
                });
                // Should have 3 cells
                assert.equal(wrapper.find('NativeCell').length, 3, 'Cell not deleted');

                // Undo the delete
                await undo();

                // Should have 4 cells again
                assert.equal(wrapper.find('NativeCell').length, 4, 'Cell delete not undone');

                // Redo the delete
                await redo();

                // Should have 3 cells again
                assert.equal(wrapper.find('NativeCell').length, 3, 'Cell delete not redone');

                // Move some cells around
                cell = getLastOutputCell(wrapper, 'NativeCell');
                imageButtons = cell.find(ImageButton);
                assert.equal(imageButtons.length, 6, 'Cell buttons not found');
                const moveUpButton = imageButtons.at(0);
                await getNativeCellResults(ioc, wrapper, async () => {
                    moveUpButton.simulate('click');
                    return Promise.resolve();
                });

                let foundCell = getOutputCell(wrapper, 'NativeCell', 2)?.instance() as NativeCell;
                assert.equal(foundCell.props.cellVM.cell.id, 'NotebookImport#1', 'Cell did not move');
                await undo();
                foundCell = getOutputCell(wrapper, 'NativeCell', 2)?.instance() as NativeCell;
                assert.equal(foundCell.props.cellVM.cell.id, 'NotebookImport#2', 'Cell did not move back');
            });
        });

        suite('Keyboard Shortcuts', () => {
            const originalPlatform = window.navigator.platform;
            Object.defineProperty(
                window.navigator,
                'platform',
                ((value: string) => {
                    return {
                        get: () => value,
                        set: (v: string) => (value = v)
                    };
                })(originalPlatform)
            );
            setup(async function() {
                (window.navigator as any).platform = originalPlatform;
                initIoc();
                // tslint:disable-next-line: no-invalid-this
                await setupFunction.call(this);
            });
            teardown(() => ((window.navigator as any).platform = originalPlatform));
            test('Traverse cells by using ArrowUp and ArrowDown, k and j', async () => {
                const keyCodesAndPositions = [
                    // When we press arrow down in the first cell, then second cell gets selected.
                    { keyCode: 'ArrowDown', cellIndexToPressKeysOn: 0, expectedSelectedCell: 1 },
                    { keyCode: 'ArrowDown', cellIndexToPressKeysOn: 1, expectedSelectedCell: 2 },
                    // Arrow down on last cell is a noop.
                    { keyCode: 'ArrowDown', cellIndexToPressKeysOn: 2, expectedSelectedCell: 2 },
                    // When we press arrow up in the last cell, then second cell (from bottom) gets selected.
                    { keyCode: 'ArrowUp', cellIndexToPressKeysOn: 2, expectedSelectedCell: 1 },
                    { keyCode: 'ArrowUp', cellIndexToPressKeysOn: 1, expectedSelectedCell: 0 },
                    // Arrow up on last cell is a noop.
                    { keyCode: 'ArrowUp', cellIndexToPressKeysOn: 0, expectedSelectedCell: 0 },

                    // Same tests as above with k and j.
                    { keyCode: 'j', cellIndexToPressKeysOn: 0, expectedSelectedCell: 1 },
                    { keyCode: 'j', cellIndexToPressKeysOn: 1, expectedSelectedCell: 2 },
                    // Arrow down on last cell is a noop.
                    { keyCode: 'j', cellIndexToPressKeysOn: 2, expectedSelectedCell: 2 },
                    { keyCode: 'k', cellIndexToPressKeysOn: 2, expectedSelectedCell: 1 },
                    { keyCode: 'k', cellIndexToPressKeysOn: 1, expectedSelectedCell: 0 },
                    // Arrow up on last cell is a noop.
                    { keyCode: 'k', cellIndexToPressKeysOn: 0, expectedSelectedCell: 0 }
                ];

                // keypress on first cell, then second, then third.
                // Test navigation through all cells, by traversing up and down.
                for (const testItem of keyCodesAndPositions) {
                    simulateKeyPressOnCell(testItem.cellIndexToPressKeysOn, { code: testItem.keyCode });

                    // Check if it is selected.
                    // Only the cell at the index should be selected, as that's what we click.
                    assert.ok(isCellSelected(wrapper, 'NativeCell', testItem.expectedSelectedCell) === true);
                }
            });

            test('Traverse cells by using ArrowUp and ArrowDown, k and j', async () => {
                const keyCodesAndPositions = [
                    // When we press arrow down in the first cell, then second cell gets selected.
                    { keyCode: 'ArrowDown', cellIndexToPressKeysOn: 0, expectedIndex: 1 },
                    { keyCode: 'ArrowDown', cellIndexToPressKeysOn: 1, expectedIndex: 2 },
                    // Arrow down on last cell is a noop.
                    { keyCode: 'ArrowDown', cellIndexToPressKeysOn: 2, expectedIndex: 2 },
                    // When we press arrow up in the last cell, then second cell (from bottom) gets selected.
                    { keyCode: 'ArrowUp', cellIndexToPressKeysOn: 2, expectedIndex: 1 },
                    { keyCode: 'ArrowUp', cellIndexToPressKeysOn: 1, expectedIndex: 0 },
                    // Arrow up on last cell is a noop.
                    { keyCode: 'ArrowUp', cellIndexToPressKeysOn: 0, expectedIndex: 0 }
                ];

                // keypress on first cell, then second, then third.
                // Test navigation through all cells, by traversing up and down.
                for (const testItem of keyCodesAndPositions) {
                    simulateKeyPressOnCell(testItem.cellIndexToPressKeysOn, { code: testItem.keyCode });

                    // Check if it is selected.
                    // Only the cell at the index should be selected, as that's what we click.
                    assert.ok(isCellSelected(wrapper, 'NativeCell', testItem.expectedIndex) === true);
                }
            });

            test("Pressing 'Enter' on a selected cell, results in focus being set to the code", async () => {
                // For some reason we cannot allow setting focus to monaco editor.
                // Tests are known to fall over if allowed.
                wrapper.update();
                const editor = wrapper
                    .find(NativeCell)
                    .at(1)
                    .find(Editor)
                    .first();
                (editor.instance() as Editor).giveFocus = () => editor.props().focused!();

                const update = waitForUpdate(wrapper, NativeEditor, 1);
                clickCell(1);
                simulateKeyPressOnCell(1, { code: 'Enter', editorInfo: undefined });
                await update;

                // The second cell should be selected.
                assert.ok(isCellFocused(wrapper, 'NativeCell', 1));
            });

            test("Pressing 'Escape' on a focused cell results in the cell being selected", async () => {
                // First focus the cell.
                let update = waitForUpdate(wrapper, NativeEditor, 1);
                clickCell(1);
                simulateKeyPressOnCell(1, { code: 'Enter', editorInfo: undefined });
                await update;

                // The second cell should be selected.
                assert.equal(isCellSelected(wrapper, 'NativeCell', 1), false);
                assert.equal(isCellFocused(wrapper, 'NativeCell', 1), true);

                // Now hit escape.
                update = waitForUpdate(wrapper, NativeEditor, 1);
                simulateKeyPressOnCell(1, { code: 'Escape' });
                await update;

                // Confirm it is no longer focused, and it is selected.
                assert.equal(isCellSelected(wrapper, 'NativeCell', 1), true);
                assert.equal(isCellFocused(wrapper, 'NativeCell', 1), false);
            });

            test("Pressing 'Shift+Enter' on a selected cell executes the cell and advances to the next cell", async () => {
                let update = waitForUpdate(wrapper, NativeEditor, 1);
                clickCell(1);
                simulateKeyPressOnCell(1, { code: 'Enter', editorInfo: undefined });
                await update;

                // The 2nd cell should be focused
                assert.ok(isCellFocused(wrapper, 'NativeCell', 1));

                update = waitForMessage(ioc, InteractiveWindowMessages.ExecutionRendered);
                simulateKeyPressOnCell(1, { code: 'Enter', shiftKey: true, editorInfo: undefined });
                await update;
                wrapper.update();

                // Ensure cell was executed.
                verifyHtmlOnCell(wrapper, 'NativeCell', '<span>2</span>', 1);

                // The third cell should be selected.
                assert.ok(isCellSelected(wrapper, 'NativeCell', 2));

                // The third cell should not be focused
                assert.ok(!isCellFocused(wrapper, 'NativeCell', 2));

                // Shift+enter on the last cell, it should behave differently. It should be selected and focused

                // First focus the cell.
                update = waitForMessage(ioc, InteractiveWindowMessages.FocusedCellEditor);
                clickCell(2);
                simulateKeyPressOnCell(2, { code: 'Enter', editorInfo: undefined });
                await update;

                // The 3rd cell should be focused
                assert.ok(isCellFocused(wrapper, 'NativeCell', 2));

                update = waitForMessage(ioc, InteractiveWindowMessages.ExecutionRendered);
                simulateKeyPressOnCell(2, { code: 'Enter', shiftKey: true, editorInfo: undefined });
                await update;
                wrapper.update();

                // The fourth cell should be focused and not selected.
                assert.ok(!isCellSelected(wrapper, 'NativeCell', 3));

                // The fourth cell should be focused
                assert.ok(isCellFocused(wrapper, 'NativeCell', 3));
            });

            test("Pressing 'Ctrl+Enter' on a selected cell executes the cell and cell selection is not changed", async () => {
                const update = waitForMessage(ioc, InteractiveWindowMessages.ExecutionRendered);
                clickCell(1);
                simulateKeyPressOnCell(1, { code: 'Enter', ctrlKey: true, editorInfo: undefined });
                await update;

                // Ensure cell was executed.
                verifyHtmlOnCell(wrapper, 'NativeCell', '<span>2</span>', 1);

                // The first cell should be selected.
                assert.ok(isCellSelected(wrapper, 'NativeCell', 1));
            });

            test("Pressing 'Alt+Enter' on a selected cell adds a new cell below it", async () => {
                // Initially 3 cells.
                wrapper.update();
                assert.equal(wrapper.find('NativeCell').length, 3);

                const update = waitForMessage(ioc, InteractiveWindowMessages.FocusedCellEditor);
                clickCell(1);
                simulateKeyPressOnCell(1, { code: 'Enter', altKey: true, editorInfo: undefined });
                await update;

                // The second cell should be focused.
                assert.ok(isCellFocused(wrapper, 'NativeCell', 2));
                // There should be 4 cells.
                assert.equal(wrapper.find('NativeCell').length, 4);
            });

            test('Auto brackets work', async () => {
                wrapper.update();
                // Initially 3 cells.
                assert.equal(wrapper.find('NativeCell').length, 3);

                // Give focus
                let update = waitForUpdate(wrapper, NativeEditor, 1);
                clickCell(1);
                await update;
                update = waitForMessage(ioc, InteractiveWindowMessages.FocusedCellEditor);
                simulateKeyPressOnCell(1, { code: 'Enter', editorInfo: undefined });
                await update;

                // The first cell should be focused.
                assert.ok(isCellFocused(wrapper, 'NativeCell', 1));

                // Add cell
                await addCell(wrapper, ioc, '', false);
                assert.equal(wrapper.find('NativeCell').length, 4);

                // New cell should have focus
                assert.ok(isCellFocused(wrapper, 'NativeCell', 2));

                const editorEnzyme = getNativeFocusedEditor(wrapper);

                // Type in something with brackets
                typeCode(editorEnzyme, 'a(');

                // Verify cell content
                const reactEditor = editorEnzyme!.instance() as MonacoEditor;
                const editor = reactEditor.state.editor;
                if (editor) {
                    assert.equal(editor.getModel()!.getValue(), 'a()', 'Text does not have brackets');
                }
            });

            test("Pressing 'd' on a selected cell twice deletes the cell", async () => {
                // Initially 3 cells.
                wrapper.update();
                assert.equal(wrapper.find('NativeCell').length, 3);

                clickCell(2);
                simulateKeyPressOnCell(2, { code: 'd' });
                simulateKeyPressOnCell(2, { code: 'd' });

                // There should be 2 cells.
                assert.equal(wrapper.find('NativeCell').length, 2);
            });

            test("Pressing 'a' on a selected cell adds a cell at the current position", async () => {
                // Initially 3 cells.
                wrapper.update();
                assert.equal(wrapper.find('NativeCell').length, 3);

                // const secondCell = wrapper.find('NativeCell').at(1);

                clickCell(0);
                const update = waitForUpdate(wrapper, NativeEditor, 1);
                simulateKeyPressOnCell(0, { code: 'a' });
                await update;

                // There should be 4 cells.
                assert.equal(wrapper.find('NativeCell').length, 4);

                // Verify cell indexes of old items.
                verifyCellIndex(wrapper, 'div[id="NotebookImport#0"]', 1);
                verifyCellIndex(wrapper, 'div[id="NotebookImport#1"]', 2);
                verifyCellIndex(wrapper, 'div[id="NotebookImport#2"]', 3);
            });

            test("Pressing 'b' on a selected cell adds a cell after the current position", async () => {
                // Initially 3 cells.
                wrapper.update();
                assert.equal(wrapper.find('NativeCell').length, 3);

                clickCell(1);
                const update = waitForUpdate(wrapper, NativeEditor, 1);
                simulateKeyPressOnCell(1, { code: 'b' });
                await update;

                // There should be 4 cells.
                assert.equal(wrapper.find('NativeCell').length, 4);

                // Verify cell indexes of old items.
                verifyCellIndex(wrapper, 'div[id="NotebookImport#0"]', 0);
                verifyCellIndex(wrapper, 'div[id="NotebookImport#1"]', 1);
                verifyCellIndex(wrapper, 'div[id="NotebookImport#2"]', 3);
            });

            test('Toggle visibility of output', async () => {
                // First execute contents of last cell.
                let update = waitForMessage(ioc, InteractiveWindowMessages.ExecutionRendered);
                clickCell(2);
                simulateKeyPressOnCell(2, { code: 'Enter', ctrlKey: true, editorInfo: undefined });
                await update;

                // Ensure cell was executed.
                verifyHtmlOnCell(wrapper, 'NativeCell', '<span>3</span>', 2);

                // Hide the output
                update = waitForUpdate(wrapper, NativeEditor, 1);
                simulateKeyPressOnCell(2, { code: 'o' });
                await update;

                // Ensure cell output is hidden (looking for cell results will throw an exception).
                assert.throws(() => verifyHtmlOnCell(wrapper, 'NativeCell', '<span>3</span>', 2));

                // Display the output
                update = waitForUpdate(wrapper, NativeEditor, 1);
                simulateKeyPressOnCell(2, { code: 'o' });
                await update;

                // Ensure cell output is visible again.
                verifyHtmlOnCell(wrapper, 'NativeCell', '<span>3</span>', 2);
            });

            test("Toggle line numbers using the 'l' key", async () => {
                clickCell(1);

                const monacoEditorComponent = wrapper
                    .find(NativeCell)
                    .at(1)
                    .find(MonacoEditor)
                    .first();
                const editor = (monacoEditorComponent.instance().state as IMonacoEditorState).editor!;
                const optionsUpdated = sinon.spy(editor, 'updateOptions');

                // Display line numbers.
                simulateKeyPressOnCell(1, { code: 'l' });
                // Confirm monaco editor got updated with line numbers set to turned on.
                assert.equal(optionsUpdated.lastCall.args[0].lineNumbers, 'on');

                // toggle the display of line numbers.
                simulateKeyPressOnCell(1, { code: 'l' });
                // Confirm monaco editor got updated with line numbers set to turned ff.
                assert.equal(optionsUpdated.lastCall.args[0].lineNumbers, 'off');
            });

            test("Toggle markdown and code modes using 'y' and 'm' keys", async () => {
                clickCell(1);

                // Switch to markdown
                let update = waitForMessage(ioc, InteractiveWindowMessages.FocusedCellEditor);
                simulateKeyPressOnCell(1, { code: 'm' });
                await update;

                // Monaco editor should be rendered and the cell should be markdown
                assert.ok(isCellFocused(wrapper, 'NativeCell', 1), '1st cell is not focused');
                assert.ok(isCellMarkdown(wrapper, 'NativeCell', 1), '1st cell is not markdown');
                assert.equal(
                    wrapper
                        .find(NativeCell)
                        .at(1)
                        .find(MonacoEditor).length,
                    1
                );

                // Change the markdown
                let editor = getNativeFocusedEditor(wrapper);
                injectCode(editor, 'foo');

                // Switch back to code mode.
                // First lose focus
                update = waitForMessage(ioc, InteractiveWindowMessages.UnfocusedCellEditor);
                simulateKeyPressOnCell(1, { code: 'Escape' });
                await update;

                // Confirm markdown output is rendered
                assert.ok(!isCellFocused(wrapper, 'NativeCell', 1), '1st cell is focused');
                assert.ok(isCellMarkdown(wrapper, 'NativeCell', 1), '1st cell is not markdown');
                assert.equal(
                    wrapper
                        .find(NativeCell)
                        .at(1)
                        .find(MonacoEditor).length,
                    0
                );

                // Switch to code
                update = waitForMessage(ioc, InteractiveWindowMessages.FocusedCellEditor);
                // At this moment, there's no cell input element, hence send key strokes to the wrapper.
                const wrapperElement = wrapper
                    .find(NativeCell)
                    .at(1)
                    .find('.cell-wrapper')
                    .first();
                wrapperElement.simulate('keyDown', { key: 'y' });
                await update;

                assert.ok(isCellFocused(wrapper, 'NativeCell', 1), '1st cell is not focused 2nd time');
                assert.ok(!isCellMarkdown(wrapper, 'NativeCell', 1), '1st cell is markdown second time');

                // Confirm editor still has the same text
                editor = getNativeFocusedEditor(wrapper);
                const monacoEditor = editor!.instance() as MonacoEditor;
                assert.equal('foo', monacoEditor.state.editor!.getValue(), 'Changing cell type lost input');
            });
        });

        suite('Update Metadata', () => {
            setup(async function() {
                initIoc();

                const oldJson: nbformat.INotebookContent = {
                    nbformat: 4,
                    nbformat_minor: 2,
                    cells: [
                        {
                            cell_type: 'code',
                            execution_count: 1,
                            metadata: {
                                collapsed: true
                            },
                            outputs: [
                                {
                                    data: {
                                        'text/plain': ['1']
                                    },
                                    output_type: 'execute_result',
                                    execution_count: 1,
                                    metadata: {}
                                }
                            ],
                            source: ['a=1\n', 'a']
                        },
                        {
                            cell_type: 'code',
                            execution_count: 2,
                            metadata: {},
                            outputs: [
                                {
                                    data: {
                                        'text/plain': ['2']
                                    },
                                    output_type: 'execute_result',
                                    execution_count: 2,
                                    metadata: {}
                                }
                            ],
                            source: ['b=2\n', 'b']
                        },
                        {
                            cell_type: 'code',
                            execution_count: 3,
                            metadata: {},
                            outputs: [
                                {
                                    data: {
                                        'text/plain': ['3']
                                    },
                                    output_type: 'execute_result',
                                    execution_count: 3,
                                    metadata: {}
                                }
                            ],
                            source: ['c=3\n', 'c']
                        }
                    ],
                    metadata: {
                        orig_nbformat: 4,
                        kernelspec: {
                            display_name: 'JUNK',
                            name: 'JUNK'
                        },
                        language_info: {
                            name: 'python',
                            version: '1.2.3'
                        }
                    }
                };

                // tslint:disable-next-line: no-invalid-this
                await setupFunction.call(this, JSON.stringify(oldJson));
            });

            test('Update notebook metadata on execution', async () => {
                const notebookProvider = ioc.get<INotebookEditorProvider>(INotebookEditorProvider);
                const editor = notebookProvider.editors[0];
                assert.ok(editor, 'No editor when saving');

                // add cells, run them and save
                await addCell(wrapper, ioc, 'a=1\na');
                const runAllButton = findButton(wrapper, NativeEditor, 0);
                const threeCellsUpdated = waitForMessage(ioc, InteractiveWindowMessages.ExecutionRendered, { numberOfTimes: 3 });
                await waitForMessageResponse(ioc, () => runAllButton!.simulate('click'));
                await threeCellsUpdated;

                const saveButton = findButton(wrapper, NativeEditor, 8);
                const saved = waitForMessage(ioc, InteractiveWindowMessages.NotebookClean);
                await waitForMessageResponse(ioc, () => saveButton!.simulate('click'));
                await saved;

                // the file has output and execution count
                const fileContent = await fs.readFile(notebookFile.filePath, 'utf8');
                const fileObject = JSON.parse(fileContent);

                // The version should be updated to something not "1.2.3"
                assert.notEqual(fileObject.metadata.language_info.version, '1.2.3');

                // Some tests don't have a kernelspec, in which case we should remove it
                // If there is a spec, we should update the name and display name
                const isRollingBuild = process.env ? process.env.VSCODE_PYTHON_ROLLING !== undefined : false;
                if (isRollingBuild && fileObject.metadata.kernelspec) {
                    assert.notEqual(fileObject.metadata.kernelspec.display_name, 'JUNK');
                    assert.notEqual(fileObject.metadata.kernelspec.name, 'JUNK');
                }
            });
        });

        suite('Clear Outputs', () => {
            setup(async function() {
                initIoc();
                // tslint:disable-next-line: no-invalid-this
                await setupFunction.call(this);
            });

            // function verifyExecutionCount(cellIndex: number, executionCountContent: string) {
            //     const foundResult = wrapper.find('NativeCell');
            //     assert.ok(foundResult.length >= 1, 'Didn\'t find any cells being rendered');
            //     const targetCell = foundResult.at(cellIndex);
            //     assert.ok(targetCell!, 'Target cell doesn\'t exist');

            //     const sliced = executionCountContent.substr(0, min([executionCountContent.length, 100]));
            //     const output = targetCell!.find('div.execution-count');
            //     assert.ok(output.length > 0, 'No output cell found');
            //     const outHtml = output.html();
            //     assert.ok(outHtml.includes(sliced), `${outHtml} does not contain ${sliced}`);
            // }

            // This test always times out in the Azure Pipeline, even though it works locally.
            // test('Clear Outputs in HTML', async () => {
            //     // Run all Cells
            //     const baseFile2 = [ {id: 'NotebookImport#0', data: {source: 'a=1\na'}},
            //     {id: 'NotebookImport#1', data: {source: 'b=2\nb'}},
            //     {id: 'NotebookImport#2', data: {source: 'c=3\nc'}}];
            //     const runAllCells =  baseFile2.map(cell => {
            //         return createFileCell(cell, cell.data);
            //     });

            //     const notebook = await ioc.get<INotebookExporter>(INotebookExporter).translateToNotebook(runAllCells, undefined);
            //     await openEditor(ioc, JSON.stringify(notebook));

            //     const runAllButton = findButton(wrapper, NativeEditor, 0);
            //     await waitForMessageResponse(ioc, () => runAllButton!.simulate('click'));

            //     await waitForUpdate(wrapper, NativeEditor, 15);

            //     verifyHtmlOnCell(wrapper, 'NativeCell', `1`, 0);
            //     verifyHtmlOnCell(wrapper, 'NativeCell', `2`, 1);
            //     verifyHtmlOnCell(wrapper, 'NativeCell', `3`, 2);

            //     // After adding the cells, clear them
            //     const clearAllOutputButton = findButton(wrapper, NativeEditor, 6);
            //     await waitForMessageResponse(ioc, () => clearAllOutputButton!.simulate('click'));

            //     await sleep(1000);

            //     verifyHtmlOnCell(wrapper, 'NativeCell', undefined, 0);
            //     verifyHtmlOnCell(wrapper, 'NativeCell', undefined, 1);
            //     verifyHtmlOnCell(wrapper, 'NativeCell', undefined, 2);

            //     verifyExecutionCount(0, '-');
            //     verifyExecutionCount(1, '-');
            //     verifyExecutionCount(2, '-');
            // });

            test('Clear Outputs in File', async () => {
                const notebookProvider = ioc.get<INotebookEditorProvider>(INotebookEditorProvider);
                const editor = notebookProvider.editors[0];
                assert.ok(editor, 'No editor when saving');
                // add cells, run them and save
                await addCell(wrapper, ioc, 'a=1\na');
                const runAllButton = findButton(wrapper, NativeEditor, 0);
                await waitForMessageResponse(ioc, () => runAllButton!.simulate('click'));

                const saveButton = findButton(wrapper, NativeEditor, 8);
                let saved = waitForMessage(ioc, InteractiveWindowMessages.NotebookClean);
                await waitForMessageResponse(ioc, () => saveButton!.simulate('click'));
                await saved;

                // the file has output and execution count
                const fileContent = await fs.readFile(notebookFile.filePath, 'utf8');

                // press clear all outputs, and save
                const clearAllOutputButton = findButton(wrapper, NativeEditor, 6);
                await waitForMessageResponse(ioc, () => clearAllOutputButton!.simulate('click'));

                saved = waitForMessage(ioc, InteractiveWindowMessages.NotebookClean);
                await waitForMessageResponse(ioc, () => saveButton!.simulate('click'));
                await saved;

                // the file now shouldn't have outputs or execution count
                const newFileContent = await fs.readFile(notebookFile.filePath, 'utf8');
                assert.notEqual(newFileContent, fileContent, 'File did not change.');
            });
        });
    });
});
