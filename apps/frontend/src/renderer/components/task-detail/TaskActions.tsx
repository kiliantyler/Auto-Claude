import { Play, Square, CheckCircle2, RotateCcw, Trash2, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import type { Task, TaskResetDataInfo } from '../../../shared/types';

interface TaskActionsProps {
  task: Task;
  isStuck: boolean;
  isIncomplete: boolean;
  isRunning: boolean;
  isRecovering: boolean;
  showDeleteDialog: boolean;
  isDeleting: boolean;
  deleteError: string | null;
  // Reset task props
  resetDataInfo: TaskResetDataInfo | null;
  isResetting: boolean;
  resetError: string | null;
  showResetDialog: boolean;
  onStartStop: () => void;
  onRecover: () => void;
  onDelete: () => void;
  onShowDeleteDialog: (show: boolean) => void;
  onReset: () => void;
  onShowResetDialog: (show: boolean) => void;
}

export function TaskActions({
  task,
  isStuck,
  isIncomplete,
  isRunning,
  isRecovering,
  showDeleteDialog,
  isDeleting,
  deleteError,
  resetDataInfo,
  isResetting,
  resetError,
  showResetDialog,
  onStartStop,
  onRecover,
  onDelete,
  onShowDeleteDialog,
  onReset,
  onShowResetDialog
}: TaskActionsProps) {
  const { t } = useTranslation(['tasks', 'common']);

  // Show reset button when task is in backlog and has reset-able data
  const canReset = task.status === 'backlog' && resetDataInfo?.hasResetData;

  return (
    <>
      <div className="p-4">
        {isStuck ? (
          <Button
            className="w-full"
            variant="warning"
            onClick={onRecover}
            disabled={isRecovering}
          >
            {isRecovering ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Recovering...
              </>
            ) : (
              <>
                <RotateCcw className="mr-2 h-4 w-4" />
                Recover Task
              </>
            )}
          </Button>
        ) : isIncomplete ? (
          <Button
            className="w-full"
            variant="default"
            onClick={onStartStop}
          >
            <Play className="mr-2 h-4 w-4" />
            Resume Task
          </Button>
        ) : (task.status === 'backlog' || task.status === 'in_progress' || task.status === 'ai_review') && (
          <Button
            className="w-full"
            variant={isRunning ? 'destructive' : 'default'}
            onClick={onStartStop}
          >
            {isRunning ? (
              <>
                <Square className="mr-2 h-4 w-4" />
                Stop Task
              </>
            ) : (
              <>
                <Play className="mr-2 h-4 w-4" />
                Start Task
              </>
            )}
          </Button>
        )}
        {task.status === 'done' && (
          <div className="completion-state text-sm">
            <CheckCircle2 className="h-5 w-5" />
            <span className="font-medium">Task completed successfully</span>
          </div>
        )}

        {/* Reset Button - visible for stopped tasks with reset-able data */}
        {canReset && (
          <Button
            variant="outline"
            size="sm"
            className="w-full mt-3 text-muted-foreground hover:text-warning hover:border-warning"
            onClick={() => onShowResetDialog(true)}
            disabled={isResetting}
          >
            {isResetting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('tasks:actions.resetting')}
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('tasks:actions.resetTask')}
              </>
            )}
          </Button>
        )}

        {/* Delete Button - always visible but disabled when running */}
        <Button
          variant="ghost"
          size="sm"
          className="w-full mt-3 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={() => onShowDeleteDialog(true)}
          disabled={(isRunning && !isStuck) || isResetting}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {t('tasks:actions.deleteTask')}
        </Button>
      </div>

      {/* Reset Confirmation Dialog */}
      <AlertDialog open={showResetDialog} onOpenChange={onShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-warning" />
              {t('tasks:resetDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-3">
                <p>
                  {t('tasks:resetDialog.confirmMessage', { title: task.title })}
                </p>
                <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                  <p className="font-medium text-foreground text-xs">{t('tasks:resetDialog.willDelete')}:</p>
                  <ul className="text-xs space-y-0.5 ml-4 list-disc">
                    {resetDataInfo?.hasWorktree && <li>{t('tasks:resetDialog.worktree')}</li>}
                    {resetDataInfo?.hasLogs && <li>{t('tasks:resetDialog.logs')}</li>}
                    {resetDataInfo?.hasImplementationPlan && <li>{t('tasks:resetDialog.implementationPlan')}</li>}
                    {resetDataInfo?.hasQaReport && <li>{t('tasks:resetDialog.qaReport')}</li>}
                    {resetDataInfo?.hasMemoryDir && <li>{t('tasks:resetDialog.memoryData')}</li>}
                  </ul>
                </div>
                <p className="text-xs">
                  {t('tasks:resetDialog.keepSpec')}
                </p>
                {resetError && (
                  <p className="text-destructive bg-destructive/10 px-3 py-2 rounded-lg text-sm">
                    {resetError}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isResetting}>{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onReset();
              }}
              disabled={isResetting}
              className="bg-warning text-warning-foreground hover:bg-warning/90"
            >
              {isResetting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('tasks:actions.resetting')}
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('tasks:resetDialog.confirmButton')}
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={onShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Task
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-3">
                <p>
                  Are you sure you want to delete <strong className="text-foreground">"{task.title}"</strong>?
                </p>
                <p className="text-destructive">
                  This action cannot be undone. All task files, including the spec, implementation plan, and any generated code will be permanently deleted from the project.
                </p>
                {deleteError && (
                  <p className="text-destructive bg-destructive/10 px-3 py-2 rounded-lg text-sm">
                    {deleteError}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onDelete();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete Permanently
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
