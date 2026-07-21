import {
  BarChart3,
  CheckCircle2,
  ClipboardList,
  Download,
  FileSearch,
  FileText,
  History,
  ListChecks,
  Lock,
  PlaySquare,
  Search,
} from 'lucide-react'
import type { ReactNode } from 'react'
import stormwaterLogo from '../../../assets/stormwater-logo.png'
import amScoreCommentImage from './help-assets/am-score-comment.png'
import captureFrameImage from './help-assets/capture-frame.png'
import cloggingControlsImage from './help-assets/clogging-controls.png'
import confirmNoneImage from './help-assets/confirm-none.png'
import defectRoleSelectionImage from './help-assets/defect-role-selection.png'
import downloadReportImage from './help-assets/download-report.png'
import eventsDialogImage from './help-assets/events-dialog.png'
import generateReportButtonImage from './help-assets/generate-report-button.png'
import inspectionDateImage from './help-assets/inspection-date.png'
import newReportButtonImage from './help-assets/new-report-button.png'
import nextValidationImage from './help-assets/next-validation.png'
import observationDetailsDialogImage from './help-assets/observation-details-dialog.png'
import observationSeekImage from './help-assets/observation-seek.png'
import openResourceImage from './help-assets/open-resource.png'
import pipeDetailsDialogImage from './help-assets/pipe-details-dialog.png'
import pipeInfoButtonImage from './help-assets/pipe-info-button.png'
import reportTableImage from './help-assets/report-table.png'
import reviewWorkspaceImage from './help-assets/review-workspace.png'
import searchCandidatesImage from './help-assets/search-candidates.png'
import signInImage from './help-assets/sign-in.png'
import snapshotSelectionImage from './help-assets/snapshot-selection.png'
import startReportDialogImage from './help-assets/start-report-dialog.png'
import './ProactiveCCTVReviewHelp.css'

const workflowSteps = [
  {
    title: 'Create',
    text: 'Search by address or project title, select the inspection date, and start a new report only when the report does not already exist.',
  },
  {
    title: 'Review',
    text: 'Move through each pipe, review distance groups, choose defect roles, confirm clean groups, and select snapshots.',
  },
  {
    title: 'Generate',
    text: 'After every pipe is reviewed, generate the report and optionally enter a memo for the report event history.',
  },
  {
    title: 'Close',
    text: 'Submit the report to review. Managers can complete the report or return it to edit while it is ready to review.',
  },
]

const statusRows = [
  ['Pending', 'Report can be edited, regenerated, submitted to review, downloaded, or deleted when allowed.'],
  ['Ready to Review', 'Manager review is pending. The report can be completed or returned to edit.'],
  ['Completed', 'Report is closed and read-only. Users may still download the generated file.'],
]

function HelpSection({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <section className="cctv-help-section">
      <h2>
        <span className="cctv-help-section-icon">{icon}</span>
        <span>{title}</span>
      </h2>
      {children}
    </section>
  )
}

function HelpFigure({
  image,
  caption,
  wide = false,
}: {
  image: string
  caption: string
  wide?: boolean
}) {
  return (
    <figure className={`cctv-help-figure${wide ? ' cctv-help-figure-wide' : ''}`}>
      <img src={image} alt={caption} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

export default function ProactiveCCTVReviewHelp() {
  return (
    <main className="cctv-help-page">
      <div className="cctv-help-layout">
        <aside className="cctv-help-sidebar" aria-label="Help page contents">
          <img src={stormwaterLogo} alt="Storm Water Services" />
          <p>Contents</p>
          <nav className="cctv-help-toc">
            <a href="#start">Get Started</a>
            <a href="#reports">Report Management</a>
            <a href="#create">Create a New Report</a>
            <a href="#review">Review Pipes</a>
            <a href="#score">Score Defects</a>
            <a href="#clogging">Clogging</a>
            <a href="#generate">Generate and Download</a>
            <a href="#status">Status Rules</a>
          </nav>
        </aside>

        <article className="cctv-help-article">
          <header className="cctv-help-hero">
            <p className="cctv-help-breadcrumb">Portal help / Reports</p>
            <h1>Proactive CCTV Review</h1>
            <p>
              Create, review, generate, and download proactive CCTV review reports in the Storm Water Asset
              Intelligence Portal.
            </p>
          </header>

          <section className="cctv-help-workflow" aria-label="Workflow summary">
            {workflowSteps.map((step, index) => (
              <article key={step.title}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <h2>{step.title}</h2>
                <p>{step.text}</p>
              </article>
            ))}
          </section>

          <HelpSection icon={<Search size={21} />} title="Get Started" >
        <div id="start" className="cctv-help-anchor" />
        <ol className="cctv-help-steps">
          <li>Sign in with your work email address. During testing, the default password is your employee ID.</li>
          <li>Open the Reports category from the Portal home page.</li>
          <li>Select Proactive Team CCTV Review.</li>
        </ol>
        <div className="cctv-help-figure-grid">
          <HelpFigure image={signInImage} caption="Portal sign-in page." />
          <HelpFigure image={openResourceImage} caption="Open Proactive Team CCTV Review from the Reports category." />
        </div>
        <div className="cctv-help-note">
          The resource uses your current Portal role and resource permissions. If you switch roles, reopen the resource
          so the page receives the latest launch context.
        </div>
          </HelpSection>

          <HelpSection icon={<ClipboardList size={21} />} title="Report Management" >
        <div id="reports" className="cctv-help-anchor" />
        <p>
          The landing table lists existing CCTV review reports. Use the table filters and sorting controls to find a
          report by binding, search text, inspection date, status, owner, submitter, or reviewer.
        </p>
        <HelpFigure image={reportTableImage} caption="Report management table with filters and action buttons." wide />
        <div className="cctv-help-action-grid">
          <div><FileSearch size={20} /><strong>View</strong><span>Open a read-only report.</span></div>
          <div><FileText size={20} /><strong>Edit</strong><span>Continue a pending report.</span></div>
          <div><CheckCircle2 size={20} /><strong>Submit</strong><span>Move a pending report to review.</span></div>
          <div><History size={20} /><strong>Events</strong><span>Show the report history.</span></div>
          <div><Download size={20} /><strong>Download</strong><span>Download the generated report file.</span></div>
          <div><Lock size={20} /><strong>Complete</strong><span>Close a reviewed report.</span></div>
        </div>
        <HelpFigure image={eventsDialogImage} caption="Report event history dialog." wide />
          </HelpSection>

          <HelpSection icon={<ListChecks size={21} />} title="Create a New Report" >
        <div id="create" className="cctv-help-anchor" />
        <p>
          Click New Report to open the creation dialog. Search by project title or address, choose a candidate record,
          then select the inspection date or inspection date range.
        </p>
        <div className="cctv-help-figure-grid">
          <HelpFigure image={newReportButtonImage} caption="New Report button." />
          <HelpFigure image={searchCandidatesImage} caption="Search candidates for address or project title." />
          <HelpFigure image={inspectionDateImage} caption="Inspection date selector." />
          <HelpFigure image={startReportDialogImage} caption="Start report dialog." />
        </div>
        <ul className="cctv-help-list">
          <li>The report key is generated from the selected search text and inspection date.</li>
          <li>Special characters are replaced with underscores, and date ranges are stored without extra spaces.</li>
          <li>If the report already exists, the application will stop creation and tell you that the report exists.</li>
        </ul>
          </HelpSection>

          <HelpSection icon={<PlaySquare size={21} />} title="Review Pipes and Observations" >
        <div id="review" className="cctv-help-anchor" />
        <p>
          The review workspace shows the inspection video and the observation table side by side. Observations are
          grouped by distance, and each row represents one graded observation.
        </p>
        <HelpFigure image={reviewWorkspaceImage} caption="CCTV review workspace with video, pipe navigation, and observation table." wide />
        <div className="cctv-help-two-column">
          <div>
            <h3>Distance groups</h3>
            <ul className="cctv-help-list">
              <li>Enter an AM score when a group has a defect scored 3 or higher.</li>
              <li>Choose or type a defect comment for scored groups.</li>
              <li>Click Confirm None when no observation in the group has AM score 3 or higher.</li>
            </ul>
          </div>
          <div>
            <h3>Observation rows</h3>
            <ul className="cctv-help-list">
              <li>Click the MLO ID to view observation details.</li>
              <li>Select Major Defect for the main defect and Other Defect for supporting defects.</li>
              <li>Use the Extensive checkbox only for selected major or other defects.</li>
              <li>Click the snapshot link to choose the report image.</li>
            </ul>
          </div>
        </div>
        <div className="cctv-help-figure-grid">
          <HelpFigure image={pipeInfoButtonImage} caption="Pipe information button." />
          <HelpFigure image={pipeDetailsDialogImage} caption="Pipe details dialog." />
          <HelpFigure image={observationSeekImage} caption="Observation rows can seek the video to the observation time." />
          <HelpFigure image={observationDetailsDialogImage} caption="Observation detail dialog." />
        </div>
          </HelpSection>

          <HelpSection icon={<ListChecks size={21} />} title="Score and Classify Defects" >
        <div id="score" className="cctv-help-anchor" />
        <p>
          Every distance group needs either a scored major defect workflow or a confirmation that there is no AM score
          greater than or equal to 3.
        </p>
        <div className="cctv-help-figure-grid">
          <HelpFigure image={confirmNoneImage} caption="Confirm that a distance group has no AM score greater than or equal to 3." />
          <HelpFigure image={amScoreCommentImage} caption="Enter AM score and select or type a defect comment." />
          <HelpFigure image={defectRoleSelectionImage} caption="Choose Major Defect or Other Defect for selected observations." />
          <HelpFigure image={snapshotSelectionImage} caption="Select the snapshot image that should appear in the report." wide />
        </div>
          </HelpSection>

          <HelpSection icon={<BarChart3 size={21} />} title="Clogging and Video Frame Capture" >
        <div id="clogging" className="cctv-help-anchor" />
        <p>
          Enter the clogging percentage for each pipe. If the value is greater than 0, choose or type the clogging
          material, pause the video at the correct point, and click Capture.
        </p>
        <div className="cctv-help-figure-grid">
          <HelpFigure image={cloggingControlsImage} caption="Clogging percent and comment controls." />
          <HelpFigure image={captureFrameImage} caption="Capture the current video frame for clogging." wide />
        </div>
        <div className="cctv-help-note">
          The captured frame time is saved with the report data. Click the saved frame text to move the video back to
          that time.
        </div>
          </HelpSection>

          <HelpSection icon={<Download size={21} />} title="Generate and Download" >
        <div id="generate" className="cctv-help-anchor" />
        <ol className="cctv-help-steps">
          <li>Review or confirm every distance group for every pipe.</li>
          <li>Click Generate Report and enter an optional memo.</li>
          <li>Wait for the generation progress indicator to finish.</li>
          <li>Click Download to retrieve the generated report file.</li>
        </ol>
        <div className="cctv-help-figure-grid">
          <HelpFigure image={nextValidationImage} caption="Validation message shown before moving to the next pipe." />
          <HelpFigure image={generateReportButtonImage} caption="Generate Report button." />
          <HelpFigure image={downloadReportImage} caption="Download generated report." wide />
        </div>
        <p>
          Pipes with scored defects are listed first in the generated report. Pipes without scored defects and with
          clogging equal to 0 are placed at the end and sorted by pipe ID.
        </p>
          </HelpSection>

          <HelpSection icon={<CheckCircle2 size={21} />} title="Status and Review Rules" >
        <div id="status" className="cctv-help-anchor" />
        <table className="cctv-help-status-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {statusRows.map(([status, meaning]) => (
              <tr key={status}>
                <td>{status}</td>
                <td>{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="cctv-help-note cctv-help-warning">
          This resource is still in testing. Use generated documents for workflow validation until the report format is
          approved for official use.
        </div>
          </HelpSection>
        </article>
      </div>
    </main>
  )
}
