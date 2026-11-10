import { api, FullWidthPageBlock, Page, PageLayout, PageTitle, usePermissions, useQuery } from '@vendure/dashboard';

import { UPDATE } from './common';
import { settingsDocument } from './graphql';
import { LayoutEditor } from './layout-editor/editor';
import { LayoutDocument } from './layout-editor/model';

/** Settings → Invoice layout: the visual layout editor with the live preview of the real PDF. */
export function LayoutPage() {
  const { hasPermissions } = usePermissions();
  const { data, isLoading, dataUpdatedAt } = useQuery({ queryKey: ['e-invoice-settings'], queryFn: () => api.query(settingsDocument) });
  if (isLoading || !data) return null;
  const { document, logoAssetId } = data.eInvoiceChannelSettings.layout;
  return (
    <Page pageId="e-invoice-layout">
      <PageTitle>Invoice layout</PageTitle>
      <PageLayout>
        <FullWidthPageBlock blockId="e-invoice-layout-editor">
          {/* re-mounted after saving, so the saved layout becomes the new baseline */}
          <LayoutEditor
            key={dataUpdatedAt}
            saved={{ document: document as LayoutDocument, logoAssetId }}
            canUpdate={hasPermissions([UPDATE])}
          />
        </FullWidthPageBlock>
      </PageLayout>
    </Page>
  );
}
