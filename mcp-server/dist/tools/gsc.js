/**
 * Google Search Console MCP tool registration barrel.
 * 100% browser-based — uses the user's authenticated Google session.
 */
import { gscNavigateSchema, gscNavigateDescription, handleGscNavigate, gscPropertySchema, gscPropertyDescription, handleGscProperty, } from './gsc/navigate.js';
import { gscInspectUrlSchema, gscInspectUrlDescription, handleGscInspectUrl, gscInspectTestLiveSchema, gscInspectTestLiveDescription, handleGscInspectTestLive, gscInspectRequestIndexingSchema, gscInspectRequestIndexingDescription, handleGscInspectRequestIndexing, gscInspectViewCrawledSchema, gscInspectViewCrawledDescription, handleGscInspectViewCrawled, } from './gsc/inspect.js';
import { gscPerformanceQuerySchema, gscPerformanceQueryDescription, handleGscPerformanceQuery, gscPerformanceExportSchema, gscPerformanceExportDescription, handleGscPerformanceExport, gscPerformanceChartScreenshotSchema, gscPerformanceChartScreenshotDescription, handleGscPerformanceChartScreenshot, } from './gsc/performance.js';
import { gscPagesReportSchema, gscPagesReportDescription, handleGscPagesReport, gscPagesValidateFixSchema, gscPagesValidateFixDescription, handleGscPagesValidateFix, gscVideosReportSchema, gscVideosReportDescription, handleGscVideosReport, gscSitemapSchema, gscSitemapDescription, handleGscSitemap, gscRemovalsSchema, gscRemovalsDescription, handleGscRemovals, gscRemovalsCancelSchema, gscRemovalsCancelDescription, handleGscRemovalsCancel, } from './gsc/indexing.js';
import { gscCwvReportSchema, gscCwvReportDescription, handleGscCwvReport, gscHttpsReportSchema, gscHttpsReportDescription, handleGscHttpsReport, gscSecurityIssuesSchema, gscSecurityIssuesDescription, handleGscSecurityIssues, gscManualActionsSchema, gscManualActionsDescription, handleGscManualActions, gscEnhancementsSchema, gscEnhancementsDescription, handleGscEnhancements, gscLinksReportSchema, gscLinksReportDescription, handleGscLinksReport, gscLinksExportSchema, gscLinksExportDescription, handleGscLinksExport, } from './gsc/experience.js';
import { gscSettingsSchema, gscSettingsDescription, handleGscSettings, gscCrawlStatsSchema, gscCrawlStatsDescription, handleGscCrawlStats, gscUsersSchema, gscUsersDescription, handleGscUsers, gscAssociationsSchema, gscAssociationsDescription, handleGscAssociations, gscDisavowSchema, gscDisavowDescription, handleGscDisavow, gscShoppingSchema, gscShoppingDescription, handleGscShopping, gscExtractTableSchema, gscExtractTableDescription, handleGscExtractTable, gscScreenshotSchema, gscScreenshotDescription, handleGscScreenshot, } from './gsc/settings.js';
export function registerGscTools(server) {
    return [
        // Navigation + property
        server.tool('gsc_navigate', gscNavigateDescription, gscNavigateSchema, handleGscNavigate),
        server.tool('gsc_property', gscPropertyDescription, gscPropertySchema, handleGscProperty),
        // URL inspection
        server.tool('gsc_inspect_url', gscInspectUrlDescription, gscInspectUrlSchema, handleGscInspectUrl),
        server.tool('gsc_inspect_test_live', gscInspectTestLiveDescription, gscInspectTestLiveSchema, handleGscInspectTestLive),
        server.tool('gsc_inspect_request_indexing', gscInspectRequestIndexingDescription, gscInspectRequestIndexingSchema, handleGscInspectRequestIndexing),
        server.tool('gsc_inspect_view_crawled', gscInspectViewCrawledDescription, gscInspectViewCrawledSchema, handleGscInspectViewCrawled),
        // Performance
        server.tool('gsc_performance_query', gscPerformanceQueryDescription, gscPerformanceQuerySchema, handleGscPerformanceQuery),
        server.tool('gsc_performance_export', gscPerformanceExportDescription, gscPerformanceExportSchema, handleGscPerformanceExport),
        server.tool('gsc_performance_chart_screenshot', gscPerformanceChartScreenshotDescription, gscPerformanceChartScreenshotSchema, handleGscPerformanceChartScreenshot),
        // Indexing
        server.tool('gsc_pages_report', gscPagesReportDescription, gscPagesReportSchema, handleGscPagesReport),
        server.tool('gsc_pages_validate_fix', gscPagesValidateFixDescription, gscPagesValidateFixSchema, handleGscPagesValidateFix),
        server.tool('gsc_videos_report', gscVideosReportDescription, gscVideosReportSchema, handleGscVideosReport),
        server.tool('gsc_sitemap', gscSitemapDescription, gscSitemapSchema, handleGscSitemap),
        server.tool('gsc_removals', gscRemovalsDescription, gscRemovalsSchema, handleGscRemovals),
        server.tool('gsc_removals_cancel', gscRemovalsCancelDescription, gscRemovalsCancelSchema, handleGscRemovalsCancel),
        // Experience + enhancements + links
        server.tool('gsc_cwv_report', gscCwvReportDescription, gscCwvReportSchema, handleGscCwvReport),
        server.tool('gsc_https_report', gscHttpsReportDescription, gscHttpsReportSchema, handleGscHttpsReport),
        server.tool('gsc_security_issues', gscSecurityIssuesDescription, gscSecurityIssuesSchema, handleGscSecurityIssues),
        server.tool('gsc_manual_actions', gscManualActionsDescription, gscManualActionsSchema, handleGscManualActions),
        server.tool('gsc_enhancements', gscEnhancementsDescription, gscEnhancementsSchema, handleGscEnhancements),
        server.tool('gsc_links_report', gscLinksReportDescription, gscLinksReportSchema, handleGscLinksReport),
        server.tool('gsc_links_export', gscLinksExportDescription, gscLinksExportSchema, handleGscLinksExport),
        // Settings + meta
        server.tool('gsc_settings', gscSettingsDescription, gscSettingsSchema, handleGscSettings),
        server.tool('gsc_crawl_stats', gscCrawlStatsDescription, gscCrawlStatsSchema, handleGscCrawlStats),
        server.tool('gsc_users', gscUsersDescription, gscUsersSchema, handleGscUsers),
        server.tool('gsc_associations', gscAssociationsDescription, gscAssociationsSchema, handleGscAssociations),
        server.tool('gsc_disavow', gscDisavowDescription, gscDisavowSchema, handleGscDisavow),
        server.tool('gsc_shopping', gscShoppingDescription, gscShoppingSchema, handleGscShopping),
        server.tool('gsc_extract_table', gscExtractTableDescription, gscExtractTableSchema, handleGscExtractTable),
        server.tool('gsc_screenshot', gscScreenshotDescription, gscScreenshotSchema, handleGscScreenshot),
    ];
}
//# sourceMappingURL=gsc.js.map